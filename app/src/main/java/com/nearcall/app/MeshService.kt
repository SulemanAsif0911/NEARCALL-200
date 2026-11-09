package com.nearcall.app

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.Ringtone
import android.media.RingtoneManager
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Calendar
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.random.Random

private data class Peer(
    val id: String, var num: String, var name: String, var hp: Int, var last: Long,
    var pk: String = "", var av: Int = 0, var btSeen: Long = 0L
)

private data class Route(val ep: String, val hp: Int)

/** A phone number bound to one device key (trust on first use). */
private data class Known(var id: String, var pk: String, var name: String)

/** A photo / voice note that is still arriving in chunks. */
private class Inc(val total: Int) {
    var body: JSONObject? = null
    var mid = ""
    var src = ""
    var pk = ""
    var ts = 0L
    val parts = arrayOfNulls<ByteArray>(total)
    var got = 0
    var via = "bt"
    val born = System.currentTimeMillis()
}

/**
 * The mesh node. Every phone running this is a user AND a relay.
 *
 *  - Nearby Connections (P2P_CLUSTER) links phones over Bluetooth / Wi-Fi Direct, no internet needed.
 *  - Packets are flooded with a hop limit; learned reverse routes make replies, voice and files unicast.
 *  - Messages, photos, voice notes and calls are end-to-end encrypted (ECDH + AES-GCM).
 *  - A phone number is pinned to the first key seen for it, so nobody can quietly take over a number.
 *  - Text and file transfers wait in store-and-forward queues until the receiver comes into range.
 */
class MeshService : Service() {

    companion object {
        const val SERVICE_ID = "com.nearcall.mesh"
        const val MAX_NEIGHBORS = 6
        const val MAX_TTL = 200        // texts, acks, channels, SOS: up to 200 hops
        const val HELLO_TTL = 4        // neighbourhood hello, every 30 s
        const val FAR_HELLO_TTL = 200  // long-range hello (so far phones learn our key and a route), every 5 min
        const val CALL_TTL = 10        // call signalling and live voice stay local: they cannot cross 200 hops
        const val VOICE_TTL = 10
        const val FILE_TTL = 30        // photos and voice notes
        const val HDR = 15          // voice packet header bytes
        const val BHDR = 19         // file chunk header bytes
        const val CHUNK = 8000      // file bytes per chunk
        const val FR = 480          // samples per voice frame (60 ms @ 8 kHz)
        const val VN_MAX_MS = 15000L
        const val NOTIF_ID = 1
        const val CH_MESH = "mesh"
        const val CH_MSG = "msg"
        const val CH_CALL = "call"
        const val CH_SOS = "sos"

        @Volatile var instance: MeshService? = null
        @Volatile var sink: ((String) -> Unit)? = null
        private val inboxLock = Any()

        fun prefs(c: Context): SharedPreferences = c.getSharedPreferences("nc", Context.MODE_PRIVATE)

        fun mediaDir(c: Context): File = File(c.filesDir, "media")

        fun safe(s: String): String = s.filter { it.isLetterOrDigit() || it == '_' || it == '-' }.take(40)

        fun start(c: Context) {
            ContextCompat.startForegroundService(c, Intent(c, MeshService::class.java))
        }

        fun stop(c: Context) {
            c.stopService(Intent(c, MeshService::class.java))
        }

        /** Events that arrived while the UI was closed; the UI drains them when it opens. */
        fun drain(c: Context): String = synchronized(inboxLock) {
            val p = prefs(c)
            val s = p.getString("inbox", "[]") ?: "[]"
            p.edit().putString("inbox", "[]").apply()
            s
        }

        fun persist(c: Context, o: JSONObject) {
            synchronized(inboxLock) {
                val p = prefs(c)
                val old = JSONArray(p.getString("inbox", "[]") ?: "[]")
                val out = JSONArray()
                for (i in maxOf(0, old.length() - 499) until old.length()) out.put(old.get(i))
                out.put(o)
                p.edit().putString("inbox", out.toString()).apply()
            }
        }
    }

    private lateinit var p: SharedPreferences
    private lateinit var crypto: Crypto
    private val h = Handler(Looper.getMainLooper())
    private val client by lazy { Nearby.getConnectionsClient(this) }

    // identity
    lateinit var nodeId: String
    private var num = ""
    private var nm = ""
    private var av = 0
    @Volatile private var relay = true
    @Volatile private var relayEff = true
    @Volatile private var lowBatt = false
    @Volatile private var battPct = 100
    @Volatile private var relayed = 0

    // mesh state
    private val neighbors = ConcurrentHashMap<String, String>()   // endpointId -> remote nodeId
    private val pending = ConcurrentHashMap<String, String>()     // endpointId -> remote advertised name
    private val directory = ConcurrentHashMap<String, Peer>()     // nodeId -> peer info
    private val routes = ConcurrentHashMap<String, Route>()       // nodeId -> next hop
    private val known = ConcurrentHashMap<String, Known>()        // number -> pinned device
    private val conflicts = ConcurrentHashMap<String, Known>()    // number -> a different device claiming it
    private val seen = object : LinkedHashMap<String, Long>(512, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>?) = size > 20000
    }
    private val vseen = object : LinkedHashMap<String, Long>(256, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>?) = size > 800
    }
    private val bseen = object : LinkedHashMap<String, Long>(512, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>?) = size > 6000
    }
    private val store = ArrayList<JSONObject>()
    private val waitKey = ArrayList<JSONObject>()
    private val incoming = ConcurrentHashMap<String, Inc>()
    private val blobDone: MutableSet<String> = Collections.synchronizedSet(HashSet<String>())
    private val channels: MutableSet<String> = Collections.synchronizedSet(HashSet<String>())
    private val chPass = ConcurrentHashMap<String, String>()
    // Contacts-only mode: only numbers saved in the app may reach us, and only they may be contacted
    @Volatile private var contactsOnly = false
    private val allowed: MutableSet<String> = Collections.synchronizedSet(HashSet<String>())
    @Volatile private var dropped = 0
    private val blocked: MutableSet<String> = Collections.synchronizedSet(HashSet<String>())
    private val rate = ConcurrentHashMap<String, LongArray>()
    private val pingAt = ConcurrentHashMap<String, Pair<String, Long>>()
    private var lastSos = 0L
    private val delivered: MutableSet<String> = Collections.synchronizedSet(HashSet<String>())
    private val lastMissed = ConcurrentHashMap<String, Long>()
    private var lanTicks = 0
    private var btTicks = 0
    private val lastRx = ConcurrentHashMap<String, Long>()      // link -> last time anything arrived on it
    private val foundEp = ConcurrentHashMap<String, String>()   // nodeId -> Bluetooth endpoint we can see
    @Volatile private var btOn = true
    @Volatile private var callVia = "bt"
    @Volatile private var lastUsed = ""
    private var lan: LanLink? = null
    private var rf: RfLink? = null
    @Volatile private var nbOn = true
    private val lanSeen = ConcurrentHashMap<String, Long>()
    @Volatile private var lanOn = true
    private var peersPending = false
    private var tick = 0

    // call state (touched on the main thread only)
    private var callState = "idle"
    private var callPeerId = ""
    private var callNum = ""
    private var callName = ""
    private var callPk = ""
    private var callCid = ""
    private var vkey: ByteArray? = null
    private var ringStart = 0L
    private var callStartedAt = 0L
    @Volatile private var lastVoice = 0L
    @Volatile private var muted = false
    @Volatile private var speakerOn = false
    private var ringtone: Ringtone? = null

    // call audio
    @Volatile private var audioOn = false
    private val rxQueue = LinkedBlockingQueue<ByteArray>(40)
    private var ctr = 0

    // voice notes
    @Volatile private var vnOn = false
    private var vnBuf: ByteArrayOutputStream? = null
    private var vnThread: Thread? = null
    @Volatile private var vnPlayId = ""

    // ---------------------------------------------------------------- lifecycle

    override fun onBind(i: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        p = prefs(this)
        crypto = Crypto(p)
        nodeId = p.getString("id", null) ?: randomHex(4).also { p.edit().putString("id", it).apply() }
        loadAll()
        createChannels()
        fgs(false)
        loadIdentity()
        readBattery()
        startNearby()
        lanOn = p.getBoolean("lan", true)
        lan = LanLink(
            this, hexToBytes(nodeId),
            { ip, b -> h.post { handleBytes("lan:$ip", b) } },
            { ip, id -> h.post { onLanHello(ip, bytesToHex(id, 0, 4)) } }
        )
        if (lanOn) lan?.start()
        rf = RfLink(
            hexToBytes(nodeId),
            { ep, id -> h.post { onRfUp(ep, bytesToHex(id, 0, 4)) } },
            { ep, b -> h.post { handleBytes(ep, b) } },
            { ep -> h.post { onRfDown(ep) } }
        )
        if (btOn) rf?.start()
        val fb = IntentFilter()
        fb.addAction(BluetoothAdapter.ACTION_STATE_CHANGED)
        val fw = IntentFilter()
        fw.addAction(WifiManager.WIFI_STATE_CHANGED_ACTION)
        fw.addAction(WifiManager.NETWORK_STATE_CHANGED_ACTION)
        try { ContextCompat.registerReceiver(this, btStateRx, fb, ContextCompat.RECEIVER_NOT_EXPORTED) } catch (_: Exception) {}
        try { ContextCompat.registerReceiver(this, wifiStateRx, fw, ContextCompat.RECEIVER_NOT_EXPORTED) } catch (_: Exception) {}
        h.postDelayed(rfTick, 2000)
        h.postDelayed(lanTick, 3000)
        h.postDelayed(btTick, 6000)
        h.postDelayed(pendTick, 3000)
        h.postDelayed(beatTick, 2000)
        h.postDelayed(maintenance, 8000)
        emitPeers()
    }

    override fun onStartCommand(i: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        h.removeCallbacksAndMessages(null)
        if (callState != "idle") {
            signal("end", if (callPeerId.isNotEmpty()) callPeerId else "#$callNum")
            finishCall("ended")
        }
        vnOn = false
        vnPlayId = ""
        lan?.stop()
        try { unregisterReceiver(btStateRx) } catch (_: Exception) {}
        try { unregisterReceiver(wifiStateRx) } catch (_: Exception) {}
        rf?.stop()
        try {
            client.stopAdvertising()
            client.stopDiscovery()
            client.stopAllEndpoints()
        } catch (_: Exception) {}
        instance = null
        emit(JSONObject().put("k", "status").put("running", false))
        super.onDestroy()
    }

    private fun loadIdentity() {
        num = p.getString("num", "") ?: ""
        nm = (p.getString("name", "") ?: "").replace("|", " ").take(24)
        av = p.getInt("av", 0)
        relay = p.getBoolean("relay", true)
        btOn = p.getBoolean("bt", true)
        nbOn = p.getBoolean("nb", true)
    }

    private fun loadAll() {
        try {
            val a = JSONArray(p.getString("store", "[]") ?: "[]")
            synchronized(store) { for (i in 0 until a.length()) store.add(a.getJSONObject(i)) }
        } catch (_: Exception) {}
        try {
            val a = JSONArray(p.getString("wait", "[]") ?: "[]")
            synchronized(waitKey) { for (i in 0 until a.length()) waitKey.add(a.getJSONObject(i)) }
        } catch (_: Exception) {}
        try {
            val j = JSONObject(p.getString("known", "{}") ?: "{}")
            val ks = j.keys()
            while (ks.hasNext()) {
                val n = ks.next()
                val o = j.getJSONObject(n)
                known[n] = Known(o.optString("id"), o.optString("pk"), o.optString("name"))
            }
        } catch (_: Exception) {}
        try {
            val a = JSONArray(p.getString("channels", "[]") ?: "[]")
            for (i in 0 until a.length()) channels.add(a.getString(i))
        } catch (_: Exception) {}
        try {
            val a = JSONArray(p.getString("blocked", "[]") ?: "[]")
            for (i in 0 until a.length()) blocked.add(a.getString(i))
        } catch (_: Exception) {}
        try {
            val j = JSONObject(p.getString("chpass", "{}") ?: "{}")
            val ks = j.keys()
            while (ks.hasNext()) {
                val n = ks.next()
                chPass[n] = j.getString(n)
            }
        } catch (_: Exception) {}
        contactsOnly = p.getBoolean("conly", false)
        try {
            val a = JSONArray(p.getString("allowed", "[]") ?: "[]")
            for (i in 0 until a.length()) allowed.add(a.getString(i))
        } catch (_: Exception) {}
    }

    /** Called when the user changes number/name/colour. */
    fun reload() {
        loadIdentity()
        readBattery()
        try { client.stopAdvertising(); client.stopDiscovery() } catch (_: Exception) {}
        startNearby()
        sendHelloAll()
    }

    // ---------------------------------------------------------------- nearby

    private fun advName() = "$nodeId|$num|$nm"

    private fun startNearby() {
        if (num.isEmpty() || !Perms.hasNearby(this)) return
        startAdvertising()
        startDiscovery()
    }

    /** Safe to call again and again: if we already advertise, Nearby just reports that and we ignore it. */
    private fun startAdvertising() {
        if (!btOn || !nbOn || num.isEmpty() || !Perms.hasNearby(this)) return
        val ao = AdvertisingOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build()
        client.startAdvertising(advName(), SERVICE_ID, connCb, ao).addOnFailureListener { }
    }

    /** Bluetooth was switched: only the Bluetooth links restart. Wi-Fi is left alone. */
    private val btRestartRun = Runnable {
        if (btOn) {
            startNearby()
            rf?.restart()
        }
    }

    private val btStateRx = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            h.removeCallbacks(btRestartRun)
            h.postDelayed(btRestartRun, 1500)
        }
    }

    /** Wi-Fi was switched: only the Wi-Fi link restarts. Bluetooth is left alone. */
    private val wifiRestartRun = Runnable {
        if (lanOn) {
            lan?.stop()
            lan?.start()
            lan?.broadcastHello()
        }
    }

    private val wifiStateRx = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            if (i.action == WifiManager.WIFI_STATE_CHANGED_ACTION) {
                h.removeCallbacks(wifiRestartRun)
                h.postDelayed(wifiRestartRun, 1500)
            } else if (lanOn) {
                lan?.broadcastHello()
            }
        }
    }

    private fun startDiscovery() {
        if (!btOn || !nbOn) return
        val d = DiscoveryOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build()
        client.startDiscovery(SERVICE_ID, discCb, d).addOnFailureListener { }
    }

    private val discCb = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(ep: String, info: DiscoveredEndpointInfo) {
            val parts = info.endpointName.split("|")
            val rid = parts.getOrNull(0) ?: return
            if (rid == nodeId) return
            upsertPeer(rid, parts.getOrNull(1) ?: "", parts.getOrNull(2) ?: "", 1, "", 0)
            directory[rid]?.btSeen = System.currentTimeMillis()
            foundEp[rid] = ep
            if (btHas(rid) || btCount() + pending.size >= MAX_NEIGHBORS) return
            if (nodeId > rid) {
                requestConn(rid, ep)
            } else {
                // the higher id normally starts the connection; if it has not within 3 s, we start it ourselves
                h.postDelayed({
                    val e = foundEp[rid]
                    if (e != null && !btHas(rid) && !pendingHas(rid)) requestConn(rid, e)
                }, 3000)
            }
        }

        override fun onEndpointLost(ep: String) {
            for ((k, v) in foundEp) if (v == ep) foundEp.remove(k)
        }
    }

    private val connCb = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(ep: String, info: ConnectionInfo) {
            val rid = info.endpointName.substringBefore('|')
            if (btCount() + pending.size >= MAX_NEIGHBORS || btHas(rid)) {
                client.rejectConnection(ep)
                return
            }
            pending[ep] = info.endpointName
            client.acceptConnection(ep, payloadCb)
        }

        override fun onConnectionResult(ep: String, result: ConnectionResolution) {
            val name = pending.remove(ep)
            if (result.status.isSuccess && name != null) {
                val parts = name.split("|")
                neighbors[ep] = parts[0]
                lastRx[ep] = System.currentTimeMillis()
                upsertPeer(parts[0], parts.getOrNull(1) ?: "", parts.getOrNull(2) ?: "", 1, "", 0)
                routes[parts[0]] = Route(ep, 1)
                send(ep, encodeJson(helloPacket()))
                flushStore(ep)
                updateNotif()
                schedulePeers()
            } else {
                scheduleRediscover()
            }
        }

        override fun onDisconnected(ep: String) {
            lastRx.remove(ep)
            neighbors.remove(ep)
            pending.remove(ep)
            routes.entries.removeAll { it.value.ep == ep }
            updateNotif()
            schedulePeers()
            scheduleRediscover()
        }
    }

    private val payloadCb = object : PayloadCallback() {
        override fun onPayloadReceived(ep: String, payload: Payload) {
            val b = payload.asBytes() ?: return
            handleBytes(ep, b)
        }

        override fun onPayloadTransferUpdate(ep: String, update: PayloadTransferUpdate) {}
    }

    /** Entry point for every packet, whether it came over Bluetooth/Nearby or the Wi-Fi link. */
    private fun handleBytes(ep: String, b: ByteArray) {
        if (b.isEmpty()) return
        val now = System.currentTimeMillis()
        lastRx[ep] = now
        if (ep.startsWith("lan:")) lanSeen[ep] = now
        try {
            when (b[0].toInt()) {
                1 -> onJson(ep, JSONObject(String(b, 1, b.size - 1, Charsets.UTF_8)))
                2 -> onVoice(ep, b)
                3 -> onChunk(ep, b)
                // 4 = heartbeat: lastRx above is all we need
            }
        } catch (_: Exception) {}
    }

    private fun send(ep: String, bytes: ByteArray) {
        if (ep.startsWith("lan:")) {
            lan?.sendTo(ep.substring(4), bytes)
            return
        }
        if (ep.startsWith("rf:")) {
            rf?.send(ep, bytes)
            return
        }
        client.sendPayload(ep, Payload.fromBytes(bytes)).addOnFailureListener { }
    }

    /** Bluetooth/Nearby links only; Wi-Fi neighbours don't use up those slots. */
    private fun pendingHas(id: String): Boolean = pending.values.any { it.startsWith("$id|") }

    private fun requestConn(rid: String, ep: String) {
        if (!btOn || !nbOn || btHas(rid) || pendingHas(rid)) return
        client.requestConnection(advName(), ep, connCb).addOnFailureListener { e ->
            val code = (e as? ApiException)?.statusCode
            if (code != ConnectionsStatusCodes.STATUS_ALREADY_CONNECTED_TO_ENDPOINT) scheduleRediscover()
        }
    }

    private fun btHas(id: String): Boolean = neighbors.entries.any { !it.key.startsWith("lan:") && it.value == id }

    private fun btCount(): Int = neighbors.keys.count { !it.startsWith("lan:") }

    // ---------------------------------------------------------------- routing

    private fun encodeJson(o: JSONObject): ByteArray = byteArrayOf(1) + o.toString().toByteArray(Charsets.UTF_8)

    private fun forMe(dst: String) = dst == nodeId || (num.isNotEmpty() && dst == "#$num")

    private fun markSeen(id: String): Boolean = synchronized(seen) {
        if (seen.containsKey(id)) false else { seen[id] = System.currentTimeMillis(); true }
    }

    private fun resolve(dst: String): String {
        if (dst.isEmpty() || dst == "*") return ""
        if (!dst.startsWith("#")) return dst
        val n = dst.substring(1)
        return known[n]?.id ?: directory.values.filter { it.num == n }.minByOrNull { it.hp }?.id ?: ""
    }

    private fun learnRoute(src: String, ep: String, hp: Int) {
        val r = routes[src]
        if (r == null || hp <= r.hp || !neighbors.containsKey(r.ep)) routes[src] = Route(ep, hp)
    }

    private fun mediumOf(ep: String) = if (ep.startsWith("lan:")) "wifi" else "bt"
    private fun other(m: String) = if (m == "wifi") "bt" else "wifi"
    private fun hasLink(m: String) = neighbors.keys.any { mediumOf(it) == m }

    private fun used(l: List<String>): String {
        val b = l.any { mediumOf(it) == "bt" }
        val w = l.any { mediumOf(it) == "wifi" }
        return if (b && w) "both" else if (w) "wifi" else if (b) "bt" else ""
    }

    /**
     * Sends a packet. `pref` is "bt", "wifi" or "any".
     *  - "bt" / "wifi": use that kind of link. If it has no way to reach the target right now, the packet
     *    switches to the other kind of link by itself (automatic failover, checked for every packet).
     *  - "any": use every link (relaying for others, acks).
     * Returns the link that was used ("bt", "wifi", "both") or "" if nothing could be sent.
     */
    private fun fwd(dst: String, bytes: ByteArray, except: String?, pref: String, hedge: Boolean = true): String {
        val target = resolve(dst)
        val eps = neighbors.keys.filter { it != except }
        if (eps.isEmpty()) return ""
        if (pref == "any") {
            if (target.isNotEmpty()) {
                val direct = eps.filter { neighbors[it] == target }
                if (direct.isNotEmpty()) {
                    for (ep in direct) send(ep, bytes)
                    return used(direct)
                }
                val r = routes[target]
                if (r != null && eps.contains(r.ep)) {
                    send(r.ep, bytes)
                    return mediumOf(r.ep)
                }
            }
            for (ep in eps) send(ep, bytes)
            return used(eps)
        }
        val order = listOf(pref, other(pref))
        if (target.isNotEmpty()) {
            // 1) a direct link to the target. If both kinds exist, use both at once: a dead link is then never noticed.
            val dp = eps.filter { mediumOf(it) == pref && neighbors[it] == target }
            val dq = eps.filter { mediumOf(it) != pref && neighbors[it] == target }
            if (dp.isNotEmpty() || dq.isNotEmpty()) {
                if (hedge && dp.isNotEmpty() && dq.isNotEmpty()) {
                    for (ep in dp + dq) send(ep, bytes)
                    return "both"
                }
                val pick = if (dp.isNotEmpty()) dp else dq
                for (ep in pick) send(ep, bytes)
                return mediumOf(pick[0])
            }
            // 2) the route we learned
            val r = routes[target]
            if (r != null && eps.contains(r.ep)) {
                send(r.ep, bytes)
                return mediumOf(r.ep)
            }
        }
        // 3) flood through neighbours of the preferred kind, else the other kind
        for (m in order) {
            val pool = eps.filter { mediumOf(it) == m }
            if (pool.isNotEmpty()) {
                for (ep in pool) send(ep, bytes)
                return m
            }
        }
        return ""
    }

    private fun forwardBytes(dst: String, bytes: ByteArray, except: String?): Boolean =
        fwd(dst, bytes, except, "any").isNotEmpty()

    private fun forward(o: JSONObject, except: String?): Boolean =
        forwardBytes(o.optString("d"), encodeJson(o), except)

    private fun forwardPref(o: JSONObject, pref: String): String =
        fwd(o.optString("d"), encodeJson(o), null, pref)

    private fun base(t: String, dst: String, ttl: Int): JSONObject =
        JSONObject().put("t", t).put("i", randomHex(8)).put("s", nodeId).put("d", dst)
            .put("ttl", ttl).put("hp", 0).put("n", num).put("nm", nm)

    private fun helloPacket(far: Boolean = false): JSONObject =
        base("hello", "", if (far) FAR_HELLO_TTL else HELLO_TTL).put("pk", crypto.pubB64).put("av", av)

    private fun sendHelloAll(far: Boolean = false) {
        val o = helloPacket(far)
        markSeen(o.getString("i"))
        for (ep in neighbors.keys) send(ep, encodeJson(o))
    }

    /** At most 200 control packets a minute from any one phone, so nobody can flood the mesh. */
    private fun allow(src: String): Boolean {
        val now = System.currentTimeMillis()
        val r = rate.getOrPut(src) { longArrayOf(now, 0L) }
        return synchronized(r) {
            if (now - r[0] > 60000) { r[0] = now; r[1] = 0L }
            r[1] = r[1] + 1
            r[1] <= 200
        }
    }

    private fun onJson(ep: String, o: JSONObject) {
        val id = o.optString("i")
        val src = o.optString("s")
        val t = o.optString("t")
        if (id.isEmpty() || src.isEmpty() || src == nodeId) return
        val dst = o.optString("d")
        val hp = o.optInt("hp") + 1
        o.put("hp", hp)

        // rate limit first: a packet we drop here must still be accepted when it is offered again
        if (!allow(src)) return
        val mine = forMe(dst) && (t == "msg" || t == "bm")
        if (mine) {
            // messages and files for us are deduplicated by what we really delivered, not by "seen"
            if (t == "msg" && delivered.contains(id)) { sendAck(src, id); return }
        } else if (!markSeen(id)) {
            return
        }
        learnRoute(src, ep, hp)

        when (t) {
            "hello" -> {
                upsertPeer(src, o.optString("n"), o.optString("nm"), hp, o.optString("pk"), o.optInt("av"))
                relayOn(o, ep)
                return
            }
            "ch" -> { deliverChannel(o); relayOn(o, ep); return }
            "sos" -> { deliverSos(o); relayOn(o, ep); return }
            "ack" -> removeStored(o.optString("m"))
        }
        if (forMe(dst)) deliver(o, src, mediumOf(ep)) else relayOn(o, ep)
    }

    private fun relayOn(o: JSONObject, from: String) {
        if (!relayEff) return
        val ttl = o.optInt("ttl") - 1
        if (ttl <= 0) return
        o.put("ttl", ttl)
        if (o.optString("t") == "msg") addStore(o)
        relayed++
        forward(o, from)
    }

    /** The section (Bluetooth / Wi-Fi) the sender chose; falls back to the link it arrived on. */
    private fun pvOf(o: JSONObject, via: String): String {
        val p = o.optString("pv")
        return if (p == "wifi") "wifi" else if (p == "bt") "bt" else via
    }

    private fun deliver(o: JSONObject, src: String, via: String) {
        val sec = pvOf(o, via)
        when (o.optString("t")) {
            "msg" -> {
                val pk = o.optString("pk")
                val body = decryptFrom(pk, o.optString("e")) ?: return
                val from = body.optString("n")
                val name = body.optString("nm")
                if (!bind(from, src, pk, name)) return
                if (blocked.contains(from)) return
                if (!okNum(from)) { dropped++; return }
                val mid = o.optString("i")
                if (body.optBoolean("mc")) {
                    // "you missed a call from me" that waited until we came back
                    val ts = o.optLong("ts", System.currentTimeMillis())
                    delivered.add(mid)
                    sendAck(src, mid)
                    val last = lastMissed[from] ?: 0L
                    if (Math.abs(ts - last) > 60000) {
                        lastMissed[from] = ts
                        notifyMissed(from, name)
                        emit(JSONObject().put("k", "missed").put("num", from).put("name", name).put("via", sec).put("ts", ts))
                    }
                    return
                }
                val text = body.optString("x")
                val ev = JSONObject().put("k", "msg").put("from", from).put("name", name)
                    .put("mid", mid).put("text", text).put("via", sec).put("link", via).put("ts", o.optLong("ts", System.currentTimeMillis()))
                val rp = body.optJSONObject("rp")
                if (rp != null) ev.put("rp", rp)
                if (sink == null && shouldNotify(from)) notifyMessage(from, name, text, from)
                delivered.add(mid)
                emit(ev)
                sendAck(src, mid)
            }
            "bm" -> onBlobMeta(o, src, via)
            "ack" -> {
                removeStored(o.optString("m"))
                emit(JSONObject().put("k", "ack").put("mid", o.optString("m")))
            }
            "call" -> h.post { onCallSignal(o, src, via) }
            "ping" -> {
                if (!okId(src)) return
                val r = base("pong", src, MAX_TTL).put("m", o.optString("i"))
                markSeen(r.getString("i"))
                forward(r, null)
            }
            "pong" -> {
                val rec = pingAt.remove(o.optString("m")) ?: return
                emit(
                    JSONObject().put("k", "pong").put("num", rec.first)
                        .put("ms", System.currentTimeMillis() - rec.second).put("hp", o.optInt("hp"))
                )
            }
        }
    }

    private fun decryptFrom(pk: String, e: String): JSONObject? {
        val key = crypto.shared(pk) ?: return null
        val raw = try { Base64.decode(e, Base64.NO_WRAP) } catch (_: Exception) { return null }
        val plain = crypto.open(key, raw) ?: return null
        return try { JSONObject(String(plain, Charsets.UTF_8)) } catch (_: Exception) { null }
    }

    private fun sendAck(dstId: String, mid: String) {
        val o = base("ack", dstId, MAX_TTL).put("m", mid)
        markSeen(o.getString("i"))
        forward(o, null)
    }

    // ---------------------------------------------------------------- identity pinning

    /**
     * Binds a phone number to a device key the first time we see it (like SSH "trust on first use").
     * A different device claiming the same number later is refused until the user trusts it.
     */
    private fun bind(n: String, id: String, pk: String, name: String): Boolean {
        if (n.isEmpty() || pk.isEmpty() || crypto.shared(pk) == null) return false
        // a 12-hex id is a key fingerprint: it only counts for the key it was made from
        if (isFp(n) && Crypto.fp(pk) != n) return false
        val k = known[n]
        if (k == null) {
            known[n] = Known(id, pk, name)
            saveKnown()
            flushWait(n)
            return true
        }
        if (k.pk == pk) {
            if (k.id != id || (name.isNotEmpty() && k.name != name)) {
                k.id = id
                if (name.isNotEmpty()) k.name = name
                saveKnown()
            }
            return true
        }
        conflicts[n] = Known(id, pk, name)
        emit(JSONObject().put("k", "conflict").put("num", n))
        return false
    }

    /** The user accepts that a number now belongs to a new phone (for example after a reinstall). */
    fun trust(n: String) {
        val c = conflicts.remove(n) ?: return
        known[n] = c
        saveKnown()
        flushWait(n)
        emitPeers()
        emit(JSONObject().put("k", "trusted").put("num", n))
    }

    private fun isFp(s: String) = s.length == 12 && s.all { it in '0'..'9' || it in 'a'..'f' }

    private fun saveKnown() {
        val j = JSONObject()
        for ((n, k) in known) j.put(n, JSONObject().put("id", k.id).put("pk", k.pk).put("name", k.name))
        p.edit().putString("known", j.toString()).apply()
    }

    // ---------------------------------------------------------------- text messages

    /** Public: the UI sends a text to a phone number. `rp` is an optional JSON {m,t} for a reply. */
    fun sendText(toNum: String, mid: String, text: String, rp: String, via: String) {
        if (toNum.isEmpty() || toNum == num) return
        if (!okNum(toNum)) { denied(toNum, "message"); return }
        val k = known[toNum]
        if (k == null) {
            addWait(
                JSONObject().put("kind", "text").put("num", toNum).put("mid", mid)
                    .put("text", text).put("rp", rp).put("via", via).put("ts", System.currentTimeMillis())
            )
            return
        }
        sendTextTo(k, mid, text, rp, System.currentTimeMillis(), via)
    }

    private fun sendTextTo(k: Known, mid: String, text: String, rp: String, ts: Long, pv: String) {
        val key = crypto.shared(k.pk) ?: return
        val body = JSONObject().put("n", num).put("nm", nm).put("x", text.take(2000))
        if (rp.isNotEmpty()) {
            try { body.put("rp", JSONObject(rp)) } catch (_: Exception) {}
        }
        val e = Base64.encodeToString(crypto.seal(key, body.toString().toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
        val o = JSONObject().put("t", "msg").put("i", mid).put("s", nodeId).put("d", k.id)
            .put("ttl", MAX_TTL).put("hp", 0).put("pk", crypto.pubB64).put("e", e).put("ts", ts).put("pv", pv)
        markSeen(mid)
        removeStored(mid)   // a resend replaces the old copy (it may be locked to an old key)
        addStore(o)
        val usedM = forwardPref(o, pv)
        if (usedM.isNotEmpty()) emit(JSONObject().put("k", "relayed").put("mid", mid).put("via", usedM))
    }

    // ---------------------------------------------------------------- store and forward

    private fun saveStore() {
        p.edit().putString("store", JSONArray(store).toString()).apply()
    }

    private fun addStore(o: JSONObject) {
        synchronized(store) {
            val id = o.optString("i")
            if (store.none { it.optString("i") == id }) {
                store.add(JSONObject(o.toString()).put("sa", System.currentTimeMillis()))
                while (store.size > 200) store.removeAt(0)
                saveStore()
            }
        }
    }

    private fun removeStored(mid: String) {
        if (mid.isEmpty()) return
        synchronized(store) {
            if (store.removeAll { it.optString("i") == mid }) saveStore()
        }
    }

    private fun flushStore(ep: String) {
        val now = System.currentTimeMillis()
        val copy = synchronized(store) {
            store.removeAll { now - it.optLong("sa") > (if (it.optString("s") == nodeId) 7 * 24 * 3600 * 1000L else 24 * 3600 * 1000L) }
            ArrayList(store)
        }
        for (o in copy) {
            val own = o.optString("s") == nodeId
            send(ep, encodeJson(o))
            if (own) emit(JSONObject().put("k", "relayed").put("mid", o.optString("i")).put("via", mediumOf(ep)))
        }
    }

    private fun saveWait() {
        p.edit().putString("wait", JSONArray(waitKey).toString()).apply()
    }

    private fun addWait(o: JSONObject) {
        synchronized(waitKey) {
            waitKey.add(o)
            while (waitKey.size > 100) waitKey.removeAt(0)
            saveWait()
        }
    }

    /** We now know this number's key: send everything that was waiting for it. */
    private fun flushWait(n: String) {
        val k = known[n] ?: return
        val items = synchronized(waitKey) {
            val l = waitKey.filter { it.optString("num") == n }
            if (l.isNotEmpty()) { waitKey.removeAll(l); saveWait() }
            l
        }
        for (o in items) {
            when (o.optString("kind")) {
                "text" -> sendTextTo(k, o.optString("mid"), o.optString("text"), o.optString("rp"), o.optLong("ts"), o.optString("via", "bt"))
                "mc" -> sendMissedTo(k, o.optLong("ts"), o.optString("via", "bt"))
                "img", "vn" -> {
                    val kind = o.optString("kind")
                    val mid = o.optString("mid")
                    val dur = o.optInt("dur")
                    val ts = o.optLong("ts")
                    val pvx = o.optString("via", "bt")
                    Thread { sendBlob(k, mid, kind, dur, ts, pvx) }.start()
                }
            }
        }
    }

    // ---------------------------------------------------------------- photos and voice notes

    /** Public: send a saved photo ("img") or voice note ("vn") whose file name is `mid`. */
    fun sendFile(toNum: String, mid: String, kind: String, dur: Int, via: String) {
        if (toNum.isEmpty() || toNum == num || safe(mid).isEmpty()) return
        if (!okNum(toNum)) { denied(toNum, "file"); return }
        val k = known[toNum]
        if (k == null) {
            addWait(
                JSONObject().put("kind", kind).put("num", toNum).put("mid", mid)
                    .put("dur", dur).put("via", via).put("ts", System.currentTimeMillis())
            )
            return
        }
        val ts = System.currentTimeMillis()
        Thread { sendBlob(k, mid, kind, dur, ts, via) }.start()
    }

    private fun fileFor(kind: String, mid: String): File =
        File(mediaDir(this), if (kind == "img") "img/${safe(mid)}.jpg" else "vn/${safe(mid)}.ul")

    private fun sendBlob(k: Known, mid: String, kind: String, dur: Int, ts: Long, pv: String) {
        try {
            val f = fileFor(kind, mid)
            if (!f.exists() || f.length() > 400_000L) return
            val key = crypto.shared(k.pk) ?: return
            val sealed = crypto.seal(key, f.readBytes())
            val chunks = (sealed.size + CHUNK - 1) / CHUNK
            val bid = randomHex(4)
            val meta = JSONObject().put("n", num).put("nm", nm).put("k", kind).put("dur", dur).put("mid", mid)
            val e = Base64.encodeToString(crypto.seal(key, meta.toString().toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
            val o = JSONObject().put("t", "bm").put("i", randomHex(8)).put("s", nodeId).put("d", k.id)
                .put("ttl", FILE_TTL).put("hp", 0).put("pk", crypto.pubB64).put("e", e)
                .put("bid", bid).put("c", chunks).put("ts", ts).put("pv", pv)
            markSeen(o.getString("i"))
            var usedM = forwardPref(o, pv)
            val srcB = hexToBytes(nodeId)
            val dstB = hexToBytes(k.id)
            val bidB = hexToBytes(bid)
            for (i in 0 until chunks) {
                val from = i * CHUNK
                val to = minOf(sealed.size, from + CHUNK)
                val pkt = ByteArray(BHDR + (to - from))
                pkt[0] = 3
                pkt[1] = FILE_TTL.toByte()
                pkt[2] = 0
                System.arraycopy(srcB, 0, pkt, 3, 4)
                System.arraycopy(dstB, 0, pkt, 7, 4)
                System.arraycopy(bidB, 0, pkt, 11, 4)
                pkt[15] = (i shr 8).toByte()
                pkt[16] = i.toByte()
                pkt[17] = (chunks shr 8).toByte()
                pkt[18] = chunks.toByte()
                System.arraycopy(sealed, from, pkt, BHDR, to - from)
                val um = fwd(k.id, pkt, null, pv, false)
                if (um.isNotEmpty()) usedM = um
                Thread.sleep(if (um == "wifi") 3L else 12L)
            }
            if (usedM.isNotEmpty()) emit(JSONObject().put("k", "relayed").put("mid", mid).put("via", usedM))
        } catch (_: Exception) {
        }
    }

    private fun onBlobMeta(o: JSONObject, src: String, via: String) {
        val pk = o.optString("pk")
        val body = decryptFrom(pk, o.optString("e")) ?: return
        val from = body.optString("n")
        if (!bind(from, src, pk, body.optString("nm"))) return
        if (blocked.contains(from)) return
        if (!okNum(from)) { dropped++; return }
        val mid = safe(body.optString("mid"))
        if (mid.isEmpty()) return
        if (blobDone.contains(mid)) { sendAck(src, mid); return }
        val bid = o.optString("bid")
        val c = o.optInt("c")
        if (bid.isEmpty() || c < 1 || c > 64) return
        val inc = incoming.getOrPut(bid) { Inc(c) }
        inc.body = body
        inc.mid = mid
        inc.src = src
        inc.via = pvOf(o, via)
        inc.pk = pk
        inc.ts = o.optLong("ts", System.currentTimeMillis())
        tryComplete(bid)
    }

    private fun onChunk(ep: String, b: ByteArray) {
        if (b.size <= BHDR) return
        val src = bytesToHex(b, 3, 4)
        val dst = bytesToHex(b, 7, 4)
        val bid = bytesToHex(b, 11, 4)
        val idx = ((b[15].toInt() and 255) shl 8) or (b[16].toInt() and 255)
        val total = ((b[17].toInt() and 255) shl 8) or (b[18].toInt() and 255)
        if (src == nodeId || total < 1 || total > 64 || idx >= total) return
        if (contactsOnly && dst == nodeId && !okId(src)) return   // file data from a phone that is not a saved contact
        val fresh = synchronized(bseen) {
            val key = "$bid:$idx"
            if (bseen.containsKey(key)) false else { bseen[key] = 1L; true }
        }
        if (!fresh) return
        val hp = (b[2].toInt() and 255) + 1
        learnRoute(src, ep, hp)
        if (dst == nodeId) {
            val inc = incoming.getOrPut(bid) { Inc(total) }
            if (idx < inc.parts.size && inc.parts[idx] == null) {
                inc.parts[idx] = b.copyOfRange(BHDR, b.size)
                inc.got++
                tryComplete(bid)
            }
        } else if (relayEff) {
            val ttl = (b[1].toInt() and 255) - 1
            if (ttl > 0) {
                val c = b.clone()
                c[1] = ttl.toByte()
                c[2] = hp.toByte()
                relayed++
                forwardBytes(dst, c, ep)
            }
        }
    }

    private fun tryComplete(bid: String) {
        val inc = incoming[bid] ?: return
        val body = inc.body ?: return
        if (inc.got < inc.total) return
        incoming.remove(bid)
        try {
            val out = ByteArrayOutputStream()
            for (part in inc.parts) out.write(part ?: return)
            val key = crypto.shared(inc.pk) ?: return
            val plain = crypto.open(key, out.toByteArray()) ?: return
            val kind = if (body.optString("k") == "img") "img" else "vn"
            val f = fileFor(kind, inc.mid)
            f.parentFile?.mkdirs()
            f.writeBytes(plain)
            blobDone.add(inc.mid)
            val from = body.optString("n")
            val name = body.optString("nm")
            val ev = JSONObject().put("k", "blob").put("from", from).put("name", name).put("mid", inc.mid)
                .put("kind", kind).put("dur", body.optInt("dur")).put("via", inc.via).put("ts", inc.ts)
            if (sink == null && shouldNotify(from)) {
                notifyMessage(from, name, if (kind == "img") "\uD83D\uDCF7 Photo" else "\uD83C\uDFA4 Voice note", from)
            }
            emit(ev)
            sendAck(inc.src, inc.mid)
        } catch (_: Exception) {
        }
    }

    // ---------------------------------------------------------------- campus channels (open, not private)

    fun joinChannel(name: String) {
        val n = Crypto.norm(name)
        if (n.isEmpty()) return
        channels.add(n)
        p.edit().putString("channels", JSONArray(channels.toList()).toString()).apply()
    }

    fun joinChannelPw(name: String, pass: String) {
        val n = Crypto.norm(name)
        if (n.isEmpty()) return
        if (pass.isEmpty()) chPass.remove(n) else chPass[n] = pass
        val j = JSONObject()
        for ((k, v) in chPass) j.put(k, v)
        p.edit().putString("chpass", j.toString()).apply()
        joinChannel(name)
    }

    fun leaveChannel(name: String) {
        channels.remove(Crypto.norm(name))
        p.edit().putString("channels", JSONArray(channels.toList()).toString()).apply()
    }

    fun sendChannel(name: String, mid: String, text: String) {
        val n = Crypto.norm(name)
        if (n.isEmpty() || text.isEmpty()) return
        val body = JSONObject().put("n", num).put("nm", nm).put("x", text.take(1000))
        val e = Base64.encodeToString(
            crypto.seal(Crypto.channelKey(n, chPass[n] ?: ""), body.toString().toByteArray(Charsets.UTF_8)), Base64.NO_WRAP
        )
        val o = JSONObject().put("t", "ch").put("i", mid).put("s", nodeId).put("d", "*")
            .put("ttl", MAX_TTL).put("hp", 0).put("c", Crypto.tag(n)).put("e", e).put("ts", System.currentTimeMillis())
            .put("pk", crypto.pubB64)
            .put("sg", Base64.encodeToString(crypto.sign((mid + "|" + e).toByteArray(Charsets.UTF_8)), Base64.NO_WRAP))
        markSeen(mid)
        if (forward(o, null)) emit(JSONObject().put("k", "relayed").put("mid", mid))
    }

    private fun deliverChannel(o: JSONObject) {
        val tag = o.optString("c")
        val name = channels.toList().firstOrNull { Crypto.tag(it) == tag } ?: return
        val raw = try { Base64.decode(o.optString("e"), Base64.NO_WRAP) } catch (_: Exception) { return }
        val plain = crypto.open(Crypto.channelKey(name, chPass[name] ?: ""), raw) ?: return
        val body = try { JSONObject(String(plain, Charsets.UTF_8)) } catch (_: Exception) { return }
        val from = body.optString("n")
        if (blocked.contains(from)) return
        // public messages are signed: a fingerprint id must match the key and the signature
        val cpk = o.optString("pk")
        val verified = cpk.isNotEmpty() && Crypto.fp(cpk) == from &&
            crypto.verify(cpk, (o.optString("i") + "|" + o.optString("e")).toByteArray(Charsets.UTF_8), o.optString("sg"))
        if (isFp(from) && !verified) return
        val who = body.optString("nm")
        val text = body.optString("x")
        if (sink == null && shouldNotify("ch:$name")) {
            notifyMessage("ch:$name", "#$name - " + (if (who.isNotEmpty()) who else from), text, "")
        }
        emit(
            JSONObject().put("k", "chmsg").put("ch", name).put("from", from).put("name", who)
                .put("mid", o.optString("i")).put("text", text).put("ok", verified).put("hp", o.optInt("hp"))
                .put("ts", o.optLong("ts", System.currentTimeMillis()))
        )
    }

    /** Panic: forget everything (keys, contacts, queues, media) and stop. A brand new identity is made next time. */
    fun wipe() {
        h.post {
            try { if (callState != "idle") finishCall("ended") } catch (_: Exception) {}
            synchronized(store) { store.clear() }
            synchronized(waitKey) { waitKey.clear() }
            known.clear(); conflicts.clear(); channels.clear(); chPass.clear(); blocked.clear()
            delivered.clear(); directory.clear(); routes.clear(); incoming.clear()
            p.edit().clear().commit()
            try { mediaDir(this).deleteRecursively() } catch (_: Exception) {}
            stopSelf()
        }
    }

    // ---------------------------------------------------------------- SOS, ping, block

    fun sendSos(text: String) {
        val now = System.currentTimeMillis()
        if (now - lastSos < 20000) return
        lastSos = now
        val o = base("sos", "*", MAX_TTL).put("x", text.take(200)).put("ts", now)
        markSeen(o.getString("i"))
        forward(o, null)
    }

    private fun deliverSos(o: JSONObject) {
        val from = o.optString("n")
        if (blocked.contains(from)) return
        val name = o.optString("nm")
        val text = o.optString("x")
        if (sink == null) {
            val title = "SOS from " + (if (name.isNotEmpty()) name else from)
            val n = NotificationCompat.Builder(this, CH_SOS)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title)
                .setContentText(if (text.isNotEmpty()) text else "Needs help nearby")
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setAutoCancel(true)
                .setContentIntent(openIntent(from))
                .build()
            try { getSystemService(NotificationManager::class.java).notify(200 + (from.hashCode() and 0xFFF), n) } catch (_: Exception) {}
        }
        emit(
            JSONObject().put("k", "sos").put("from", from).put("name", name).put("text", text)
                .put("hp", o.optInt("hp")).put("ts", System.currentTimeMillis())
        )
    }

    fun ping(toNum: String) {
        if (!okNum(toNum)) { denied(toNum, "ping"); return }
        val id = known[toNum]?.id ?: directory.values.firstOrNull { it.num == toNum }?.id ?: ""
        if (id.isEmpty()) {
            emit(JSONObject().put("k", "pong").put("num", toNum).put("ms", -1).put("hp", 0))
            return
        }
        val o = base("ping", id, MAX_TTL)
        val mid = o.getString("i")
        pingAt[mid] = Pair(toNum, System.currentTimeMillis())
        markSeen(mid)
        forward(o, null)
        h.postDelayed({
            val rec = pingAt.remove(mid)
            if (rec != null) emit(JSONObject().put("k", "pong").put("num", rec.first).put("ms", -1).put("hp", 0))
        }, 6000)
    }

    fun setBlocked(n: String, on: Boolean) {
        if (on) blocked.add(n) else blocked.remove(n)
        p.edit().putString("blocked", JSONArray(blocked.toList()).toString()).apply()
    }

    // ---------------------------------------------------------------- directory

    private fun upsertPeer(id: String, n: String, name: String, hp: Int, pk: String, avatar: Int) {
        if (id == nodeId || id.isEmpty()) return
        val now = System.currentTimeMillis()
        val pr = directory.getOrPut(id) { Peer(id, n, name, hp, now) }
        pr.num = n
        pr.name = name
        if (pk.isNotEmpty()) {
            pr.pk = pk
            pr.av = avatar
        }
        if (hp <= pr.hp || now - pr.last > 60000) pr.hp = hp
        pr.last = now
        if (pk.isNotEmpty() && n.isNotEmpty()) bind(n, id, pk, name)
        if (n.isNotEmpty() && n == num) emit(JSONObject().put("k", "dup").put("num", n))
        schedulePeers()
    }

    private fun schedulePeers() {
        if (peersPending) return
        peersPending = true
        h.postDelayed({ peersPending = false; emitPeers() }, 700)
    }

    fun emitPeers() {
        val now = System.currentTimeMillis()
        val arr = JSONArray()
        directory.values.filter { now - it.last < 15 * 60 * 1000L && it.num.isNotEmpty() && (!contactsOnly || allowed.contains(it.num)) }.sortedBy { it.hp }.forEach { pr ->
            val kn = known[pr.num]
            val conflict = kn != null && pr.pk.isNotEmpty() && kn.pk != pr.pk
            var viaBt = false
            var viaWifi = false
            for ((ep, nid) in neighbors) {
                if (nid == pr.id) { if (ep.startsWith("lan:")) viaWifi = true else viaBt = true }
            }
            val rm = routes[pr.id]?.let { mediumOf(it.ep) } ?: ""
            val anyBt = viaBt || now - pr.btSeen < 60000 || (!viaBt && !viaWifi && rm == "bt")
            val anyWf = viaWifi || (!viaBt && !viaWifi && rm == "wifi")
            arr.put(
                JSONObject().put("id", pr.id).put("num", pr.num).put("name", pr.name).put("hp", pr.hp)
                    .put("near", neighbors.containsValue(pr.id)).put("bt", anyBt).put("wifi", anyWf).put("btc", viaBt).put("wfc", viaWifi).put("av", pr.av)
                    .put("conflict", conflict).put("key", kn != null)
                    .put("age", (now - pr.last) / 1000)
            )
        }
        emit(
            JSONObject().put("k", "peers").put("list", arr).put("n", neighbors.size).put("running", true)
                .put("lowBatt", lowBatt).put("nbt", btCount()).put("nwf", neighbors.size - btCount())
        )
    }

    fun netInfo(): String {
        val arr = JSONArray()
        for ((ep, id) in neighbors) {
            val d = directory[id]
            arr.put(
                JSONObject().put("id", id).put("num", d?.num ?: "").put("name", d?.name ?: "")
                    .put("via", if (ep.startsWith("lan:")) "wifi" else "bt")
                    .put("kind", if (ep.startsWith("lan:")) "wifi" else if (ep.startsWith("rf:")) "paired" else "nearby")
                    .put("age", (System.currentTimeMillis() - (lastRx[ep] ?: System.currentTimeMillis())) / 1000)
            )
        }
        return JSONObject().put("neighbors", arr).put("peers", directory.size).put("relayed", relayed)
            .put("stored", store.size).put("battery", battPct).put("lowBatt", lowBatt)
            .put("relay", relay).put("relayOn", relayEff).put("lan", lanOn).put("id", nodeId)
            .put("conly", contactsOnly).put("dropped", dropped).toString()
    }

    private fun readBattery() {
        try {
            val i = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val lvl = i?.getIntExtra(BatteryManager.EXTRA_LEVEL, 100) ?: 100
            val scale = i?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
            val plugged = (i?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
            battPct = if (scale > 0) lvl * 100 / scale else 100
            // below 15% and unplugged the phone stops relaying for others to save its own battery
            lowBatt = battPct < 15 && !plugged
        } catch (_: Exception) {}
        relayEff = relay && !lowBatt
    }

    // ---------------------------------------------------------------- Wi-Fi / hotspot link

    private val lanTick = object : Runnable {
        override fun run() {
            if (lanOn) {
                lan?.broadcastHello()
                lanTicks++
                if (lanTicks % 15 == 0) lan?.sweep()
                val now = System.currentTimeMillis()
                for ((ep, t) in lanSeen) {
                    if (now - t > 6500) dropLink(ep)
                }
            }
            h.postDelayed(this, 3000)
        }
    }

    private fun onRfUp(ep: String, id: String) {
        if (id == nodeId || num.isEmpty()) {
            rf?.close(ep)
            return
        }
        lastRx[ep] = System.currentTimeMillis()
        val prev = neighbors.put(ep, id)
        if (prev == null) {
            routes[id] = Route(ep, 1)
            send(ep, encodeJson(helloPacket()))
            flushStore(ep)
            updateNotif()
            schedulePeers()
        }
    }

    private fun onRfDown(ep: String) {
        lastRx.remove(ep)
        if (neighbors.remove(ep) != null) {
            routes.entries.removeAll { it.value.ep == ep }
            updateNotif()
            schedulePeers()
        }
    }

    /** Every 3 s: connect to any paired phone we are not connected to (backs off by itself for phones that are away). */
    private val rfTick = object : Runnable {
        override fun run() {
            if (btOn) rf?.tryConnectAll()
            h.postDelayed(this, 3000)
        }
    }

    private fun onLanHello(ip: String, id: String) {
        if (!lanOn || id == nodeId || num.isEmpty()) return
        val ep = "lan:$ip"
        lanSeen[ep] = System.currentTimeMillis()
        lastRx[ep] = System.currentTimeMillis()
        val prev = neighbors.put(ep, id)
        if (prev == null) {
            routes[id] = Route(ep, 1)
            send(ep, encodeJson(helloPacket()))
            flushStore(ep)
            updateNotif()
            schedulePeers()
        }
    }

    fun setLan(on: Boolean) {
        lanOn = on
        p.edit().putBoolean("lan", on).apply()
        if (on) {
            lan?.start()
        } else {
            lan?.stop()
            for (ep in lanSeen.keys) {
                neighbors.remove(ep)
                routes.entries.removeAll { it.value.ep == ep }
            }
            lanSeen.clear()
            updateNotif()
            schedulePeers()
        }
    }

    fun setBt(on: Boolean) {
        btOn = on
        p.edit().putBoolean("bt", on).apply()
        if (on) {
            startNearby()
            rf?.start()
        } else {
            rf?.stop()
            try {
                client.stopAdvertising()
                client.stopDiscovery()
                client.stopAllEndpoints()
            } catch (_: Exception) {}
            for (ep in neighbors.keys.toList()) if (mediumOf(ep) == "bt") neighbors.remove(ep)
            pending.clear()
            routes.entries.removeAll { mediumOf(it.value.ep) == "bt" }
            updateNotif()
            schedulePeers()
        }
    }

    /** Switch only the automatic-discovery (Nearby) part of Bluetooth; paired direct links stay as they are. */
    fun setNearby(on: Boolean) {
        nbOn = on
        p.edit().putBoolean("nb", on).apply()
        if (on) {
            startNearby()
        } else {
            try {
                client.stopAdvertising()
                client.stopDiscovery()
                client.stopAllEndpoints()
            } catch (_: Exception) {}
            for (ep in neighbors.keys.toList()) if (!ep.startsWith("lan:") && !ep.startsWith("rf:")) neighbors.remove(ep)
            pending.clear()
            routes.entries.removeAll { val e = it.value.ep; !e.startsWith("lan:") && !e.startsWith("rf:") }
            updateNotif()
            schedulePeers()
        }
    }

    // ---------------------------------------------------------------- contacts-only mode

    private fun okNum(n: String): Boolean = !contactsOnly || allowed.contains(n)

    /** True if this node belongs to a saved contact (we know its number from its key). */
    private fun okId(id: String): Boolean = !contactsOnly || known.entries.any { it.value.id == id && allowed.contains(it.key) }

    private fun denied(n: String, what: String) {
        emit(JSONObject().put("k", "denied").put("num", n).put("what", what))
    }

    fun setContactsOnly(on: Boolean) {
        contactsOnly = on
        p.edit().putBoolean("conly", on).apply()
        schedulePeers()
    }

    /** The list of saved numbers, as a JSON array of strings. */
    fun setAllowed(json: String) {
        try {
            val a = JSONArray(json)
            val l = HashSet<String>()
            for (i in 0 until a.length()) l.add(a.getString(i))
            allowed.clear()
            allowed.addAll(l)
            p.edit().putString("allowed", a.toString()).apply()
            schedulePeers()
        } catch (_: Exception) {}
    }

    fun isLan(): Boolean = lanOn

    /**
     * Own messages that are still not acknowledged are offered again after 3 s, 6 s, 12 s, 24 s, 48 s and then
     * every minute. The first retry uses the chosen link, later retries use every link at once.
     */
    private fun resendOwn(force: Boolean) {
        val now = System.currentTimeMillis()
        val copy = synchronized(store) { ArrayList(store) }
        for (o in copy) {
            if (o.optString("s") != nodeId) continue
            val born = o.optLong("sa")
            if (now - born > 24 * 3600 * 1000L) continue
            val rc = o.optInt("rc", 0)
            if (rc >= 60) continue
            val gap = if (rc < 5) 3000L shl rc else 60000L
            if (!force && now - o.optLong("lr", born) < gap) continue
            // 1st retry: the chosen link; 2nd: every link and the learned route; 3rd and later: flood (the route may be stale)
            val usedM = when {
                rc == 0 -> forwardPref(o, o.optString("pv", "bt"))
                rc >= 2 -> {
                    val all = neighbors.keys.toList()
                    val b = encodeJson(o)
                    for (ep in all) send(ep, b)
                    used(all)
                }
                else -> fwd(o.optString("d"), encodeJson(o), null, "any")
            }
            if (usedM.isNotEmpty()) {
                o.put("lr", now).put("rc", rc + 1)
                emit(JSONObject().put("k", "relayed").put("mid", o.optString("i")).put("via", usedM))
            }
        }
    }

    /** "Reconnect now": drop silent links, search again, and push everything that is waiting. */
    fun reconnectNow() {
        h.post {
            val now = System.currentTimeMillis()
            for (ep in neighbors.keys.toList()) {
                if (now - (lastRx[ep] ?: 0L) > 4000) dropLink(ep)
            }
            rediscoverRun.run()
            startNearby()
            rf?.retryNow()
            if (lanOn) {
                lan?.broadcastHello()
                lan?.sweep()
            }
            resendOwn(true)
        }
    }

    /** Forget a link that went silent and, if it was Bluetooth, start looking again immediately. */
    private fun dropLink(ep: String) {
        val wasBt = mediumOf(ep) == "bt"
        neighbors.remove(ep)
        lastRx.remove(ep)
        lanSeen.remove(ep)
        routes.entries.removeAll { it.value.ep == ep }
        if (ep.startsWith("rf:")) {
            rf?.close(ep)
        } else if (wasBt) {
            try { client.disconnectFromEndpoint(ep) } catch (_: Exception) {}
            scheduleRediscover()
        }
        updateNotif()
        schedulePeers()
    }

    /** Every 2 s each link gets a 1-byte heartbeat; a link silent for 6 s (Wi-Fi) / 10 s (Bluetooth) is dropped. */
    private val beatTick = object : Runnable {
        override fun run() {
            val now = System.currentTimeMillis()
            for (ep in neighbors.keys.toList()) {
                val last = lastRx[ep] ?: now
                val limit = if (mediumOf(ep) == "wifi") 6000L else 10000L
                if (now - last > limit) {
                    dropLink(ep)
                } else {
                    send(ep, byteArrayOf(4))
                }
            }
            h.postDelayed(this, 2000)
        }
    }

    /** Bluetooth: look for phones again right away after a link drops or fails. */
    private val rediscoverRun = Runnable {
        if (btOn) {
            try { client.stopDiscovery() } catch (_: Exception) {}
            startDiscovery()
            startAdvertising()
        }
    }

    private fun scheduleRediscover() {
        h.removeCallbacks(rediscoverRun)
        h.postDelayed(rediscoverRun, 800)
    }

    /** Keep advertising and searching alive (both calls are harmless if already running). */
    private val btTick = object : Runnable {
        override fun run() {
            btTicks++
            if (btOn) {
                startAdvertising()
                startDiscovery()
                if (btCount() == 0 && btTicks % 4 == 0) {
                    // nothing connected for a while: reset the search completely
                    try { client.stopDiscovery() } catch (_: Exception) {}
                    startDiscovery()
                }
            }
            h.postDelayed(this, 8000)
        }
    }

    private val pendTick = object : Runnable {
        override fun run() {
            resendOwn(false)
            h.postDelayed(this, 2000)
        }
    }

    private val maintenance = object : Runnable {
        override fun run() {
            tick++
            readBattery()
            sendHelloAll()
            if (tick % 10 == 1) sendHelloAll(true)   // every 5 minutes: reach phones far away
            startAdvertising()
            val now = System.currentTimeMillis()
            for ((k, v) in incoming) if (now - v.born > 5 * 60 * 1000L) incoming.remove(k)
            for ((k, v) in rate) if (now - v[0] > 5 * 60 * 1000L) rate.remove(k)
            emitPeers()
            h.postDelayed(this, 30000)
        }
    }

    // ---------------------------------------------------------------- calls

    private fun signal(op: String, dst: String) {
        val o = base("call", dst, CALL_TTL).put("o", op).put("pk", crypto.pubB64).put("cid", callCid).put("pv", callVia)
        markSeen(o.getString("i"))
        forwardPref(o, callVia)
    }

    fun callJson(): String = JSONObject().put("k", "call").put("state", callState)
        .put("num", callNum).put("name", callName).put("via", callVia).toString()

    private fun emitCall(state: String = callState, reason: String = "", dur: Long = 0) {
        val o = JSONObject().put("k", "call").put("state", state).put("num", callNum).put("name", callName).put("via", callVia)
        if (reason.isNotEmpty()) o.put("reason", reason)
        if (dur > 0) o.put("dur", dur)
        emit(o)
    }

    /** Caller side: leave a "you missed my call" note that is delivered when the other phone is back. */
    private fun sendMissedCall(toNum: String) {
        val now = System.currentTimeMillis()
        val k = known[toNum]
        if (k == null) {
            addWait(JSONObject().put("kind", "mc").put("num", toNum).put("via", callVia).put("ts", now))
            return
        }
        sendMissedTo(k, now, callVia)
    }

    private fun sendMissedTo(k: Known, ts: Long, pv: String) {
        val key = crypto.shared(k.pk) ?: return
        val body = JSONObject().put("n", num).put("nm", nm).put("mc", true)
        val e = Base64.encodeToString(crypto.seal(key, body.toString().toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
        val mid = randomHex(8)
        val o = JSONObject().put("t", "msg").put("i", mid).put("s", nodeId).put("d", k.id)
            .put("ttl", MAX_TTL).put("hp", 0).put("pk", crypto.pubB64).put("e", e).put("ts", ts).put("pv", pv)
        markSeen(mid)
        addStore(o)
        forwardPref(o, pv)
    }

    private fun notifyMissed(n: String, name: String) {
        val title = if (name.isNotEmpty()) name else n
        val nn = NotificationCompat.Builder(this, CH_MSG)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Missed call")
            .setContentText(title)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openIntent(n))
            .build()
        try { getSystemService(NotificationManager::class.java).notify(300 + (n.hashCode() and 0xFFFF), nn) } catch (_: Exception) {}
    }

    fun startCall(toNum: String, via: String) {
        if (!okNum(toNum)) { denied(toNum, "call"); return }
        h.post {
            if (callState != "idle" || toNum.isEmpty() || toNum == num || vnOn) return@post
            callState = "out"; callNum = toNum; callPeerId = ""; callName = ""; callPk = ""
            callCid = randomHex(4)
            callVia = if (via == "wifi") "wifi" else "bt"
            ringStart = System.currentTimeMillis()
            fgs(true)
            emitCall()
            ringTick.run()
        }
    }

    private val ringTick = object : Runnable {
        override fun run() {
            if (callState != "out") return
            if (System.currentTimeMillis() - ringStart > 45000) {
                signal("end", "#$callNum")
                finishCall("noanswer")
                return
            }
            signal("ring", "#$callNum")
            h.postDelayed(this, 2500)
        }
    }

    private val liveTick = object : Runnable {
        override fun run() {
            if (callState != "active") return
            if (System.currentTimeMillis() - lastVoice > 10000) {
                signal("end", callPeerId)
                finishCall("lost")
                return
            }
            h.postDelayed(this, 2000)
        }
    }

    private fun onCallSignal(o: JSONObject, src: String, via: String) {
        val n = o.optString("n")
        val name = o.optString("nm")
        val pk = o.optString("pk")
        when (o.optString("o")) {
            "ring" -> {
                val cid = o.optString("cid")
                if (blocked.contains(n) || !Regex("^[0-9a-f]{8}\$").matches(cid)) return
                if (!okNum(n)) { dropped++; return }
                if (!bind(n, src, pk, name)) return
                when {
                    callState == "idle" -> {
                        callState = "in"; callPeerId = src; callNum = n; callName = name; callPk = pk; callCid = cid; callVia = pvOf(o, via)
                        startRing()
                        notifyIncoming(n, name)
                        emitCall()
                    }
                    callPeerId == src -> {}   // duplicate ring from the same caller
                    else -> signal("busy", src)
                }
            }
            "accept" -> if (callState == "out" && n == callNum && bind(n, src, pk, name)) {
                callPeerId = src; callName = name; callPk = pk
                h.removeCallbacks(ringTick)
                beginActive()
            }
            "reject" -> if (callState == "out") finishCall("rejected")
            "busy" -> if (callState == "out") finishCall("busy")
            "end" -> if (callState != "idle" && callPeerId == src) {
                finishCall(if (callState == "in") "missed" else "ended")
            }
        }
    }

    fun acceptCall() {
        h.post {
            if (callState != "in") return@post
            stopRing()
            cancelNotif(3)
            fgs(true)
            signal("accept", callPeerId)
            beginActive()
        }
    }

    fun rejectCall() {
        h.post {
            if (callState != "in") return@post
            signal("reject", callPeerId)
            finishCall("rejected")
        }
    }

    fun endCall() {
        h.post {
            if (callState == "idle") return@post
            signal("end", if (callPeerId.isNotEmpty()) callPeerId else "#$callNum")
            finishCall("ended")
        }
    }

    fun setMute(m: Boolean) { muted = m }

    fun setSpeaker(on: Boolean) {
        speakerOn = on
        applySpeaker()
    }

    fun setRelay(on: Boolean) {
        relay = on
        p.edit().putBoolean("relay", on).apply()
        readBattery()
    }

    private fun beginActive() {
        val sh = crypto.shared(callPk)
        if (sh == null) {
            signal("end", callPeerId)
            finishCall("nokey")
            return
        }
        vkey = Crypto.voiceKey(sh, callCid)
        callState = "active"
        callStartedAt = System.currentTimeMillis()
        lastVoice = callStartedAt
        emitCall()
        startAudio()
        h.postDelayed(liveTick, 2000)
    }

    private fun finishCall(reason: String) {
        val dur = if (callStartedAt > 0) (System.currentTimeMillis() - callStartedAt) / 1000 else 0
        h.removeCallbacks(ringTick)
        h.removeCallbacks(liveTick)
        stopAudio()
        stopRing()
        cancelNotif(3)
        val wasOut = callState == "out"
        callState = "idle"
        emitCall("idle", reason, dur)
        if (wasOut && (reason == "noanswer" || reason == "ended") && callNum.isNotEmpty()) sendMissedCall(callNum)
        if (reason == "missed") {
            lastMissed[callNum] = System.currentTimeMillis()
            notifyMissed(callNum, callName)
        }
        callPeerId = ""; callStartedAt = 0; vkey = null; callPk = ""
        fgs(false)
    }

    private fun startRing() {
        try {
            val r = RingtoneManager.getRingtone(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
            if (Build.VERSION.SDK_INT >= 28) r.isLooping = true
            r.play()
            ringtone = r
        } catch (_: Exception) {}
    }

    private fun stopRing() {
        try { ringtone?.stop() } catch (_: Exception) {}
        ringtone = null
    }

    // ---------------------------------------------------------------- live voice (encrypted)

    private fun applySpeaker() {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        @Suppress("DEPRECATION")
        am.isSpeakerphoneOn = speakerOn
    }

    @SuppressLint("MissingPermission")
    private fun startAudio() {
        if (audioOn) return
        val vk = vkey
        if (vk == null || !Perms.hasMic(this)) {
            signal("end", callPeerId)
            finishCall("nomic")
            return
        }
        val rate = 8000
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        applySpeaker()

        val minIn = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION, rate,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minIn, 4096)
        )
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            signal("end", callPeerId)
            finishCall("nomic")
            return
        }
        val minOut = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
            )
            .setAudioFormat(
                AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build()
            )
            .setBufferSizeInBytes(maxOf(minOut, 4096))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()

        val aec = if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(rec.audioSessionId) else null
        val ns = if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(rec.audioSessionId) else null
        aec?.setEnabled(true)
        ns?.setEnabled(true)

        rxQueue.clear()
        ctr = 0
        lastUsed = ""
        audioOn = true
        val peer = callPeerId
        val srcBytes = hexToBytes(nodeId)
        val dstBytes = hexToBytes(peer)
        val cidBytes = hexToBytes(callCid)

        Thread {
            val frame = ShortArray(FR)
            val plain = ByteArray(FR)
            val iv = ByteArray(12)
            try {
                rec.startRecording()
                while (audioOn) {
                    var n = 0
                    while (audioOn && n < FR) {
                        val k = rec.read(frame, n, FR - n)
                        if (k <= 0) break
                        n += k
                    }
                    if (n < FR) { Thread.sleep(10); continue }
                    val silent = muted
                    for (i in 0 until FR) plain[i] = if (silent) 0xFF.toByte() else Mulaw.enc(frame[i])
                    ctr++
                    System.arraycopy(srcBytes, 0, iv, 0, 4)
                    iv[4] = (ctr shr 24).toByte(); iv[5] = (ctr shr 16).toByte()
                    iv[6] = (ctr shr 8).toByte(); iv[7] = ctr.toByte()
                    System.arraycopy(cidBytes, 0, iv, 8, 4)
                    val ct = Crypto.sealIv(vk, iv, plain)
                    val out = ByteArray(HDR + ct.size)
                    out[0] = 2
                    out[1] = VOICE_TTL.toByte()
                    out[2] = 0
                    System.arraycopy(srcBytes, 0, out, 3, 4)
                    System.arraycopy(dstBytes, 0, out, 7, 4)
                    System.arraycopy(iv, 4, out, 11, 4)
                    System.arraycopy(ct, 0, out, HDR, ct.size)
                    val um = fwd(peer, out, null, callVia)
                    if (um.isNotEmpty() && um != lastUsed) {
                        lastUsed = um
                        emit(JSONObject().put("k", "calllink").put("via", um))
                    }
                }
            } catch (_: Exception) {
            } finally {
                try { rec.stop() } catch (_: Exception) {}
                rec.release()
                aec?.release()
                ns?.release()
            }
        }.start()

        Thread {
            val pcm = ShortArray(FR)
            try {
                track.play()
                var primed = false
                while (audioOn) {
                    val pkt = rxQueue.poll(100, TimeUnit.MILLISECONDS) ?: continue
                    if (!primed) {
                        // small jitter buffer: wait briefly for a second frame before starting
                        val t0 = System.currentTimeMillis()
                        while (audioOn && rxQueue.size < 2 && System.currentTimeMillis() - t0 < 400) Thread.sleep(20)
                        primed = true
                    }
                    val n = minOf(FR, pkt.size)
                    for (i in 0 until n) pcm[i] = Mulaw.dec(pkt[i])
                    track.write(pcm, 0, n)
                }
            } catch (_: Exception) {
            } finally {
                try { track.stop() } catch (_: Exception) {}
                track.release()
            }
        }.start()
    }

    private fun stopAudio() {
        audioOn = false
        rxQueue.clear()
        try {
            val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            am.mode = AudioManager.MODE_NORMAL
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = false
        } catch (_: Exception) {}
        muted = false
        speakerOn = false
    }

    private fun onVoice(ep: String, b: ByteArray) {
        if (b.size <= HDR) return
        val srcHex = bytesToHex(b, 3, 4)
        val dstHex = bytesToHex(b, 7, 4)
        if (srcHex == nodeId) return
        val key = srcHex + bytesToHex(b, 11, 4)
        val fresh = synchronized(vseen) { if (vseen.containsKey(key)) false else { vseen[key] = 1L; true } }
        if (!fresh) return
        val hp = (b[2].toInt() and 255) + 1
        learnRoute(srcHex, ep, hp)
        if (dstHex == nodeId) {
            val vk = vkey
            if (callState == "active" && srcHex == callPeerId && vk != null) {
                val iv = ByteArray(12)
                System.arraycopy(b, 3, iv, 0, 4)
                System.arraycopy(b, 11, iv, 4, 4)
                System.arraycopy(hexToBytes(callCid), 0, iv, 8, 4)
                val frame = Crypto.openIv(vk, iv, b, HDR, b.size - HDR) ?: return
                lastVoice = System.currentTimeMillis()
                if (!rxQueue.offer(frame)) { rxQueue.poll(); rxQueue.offer(frame) }
            }
        } else if (relayEff) {
            val ttl = (b[1].toInt() and 255) - 1
            if (ttl > 0) {
                val c = b.clone()
                c[1] = ttl.toByte()
                c[2] = hp.toByte()
                relayed++
                forwardBytes(dstHex, c, ep)
            }
        }
    }

    // ---------------------------------------------------------------- voice notes (record / play)

    /** Starts recording a voice note (max 15 s). Returns false if the mic is busy or not allowed. */
    @SuppressLint("MissingPermission")
    fun vnStart(): Boolean {
        if (vnOn || callState != "idle" || !Perms.hasMic(this)) return false
        val rate = 8000
        val minIn = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = AudioRecord(
            MediaRecorder.AudioSource.MIC, rate,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minIn, 4096)
        )
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            return false
        }
        val buf = ByteArrayOutputStream()
        vnBuf = buf
        vnOn = true
        val t = Thread {
            val frame = ShortArray(160)
            val t0 = System.currentTimeMillis()
            try {
                rec.startRecording()
                while (vnOn && System.currentTimeMillis() - t0 < VN_MAX_MS) {
                    val k = rec.read(frame, 0, frame.size)
                    if (k <= 0) { Thread.sleep(10); continue }
                    val out = ByteArray(k)
                    for (i in 0 until k) out[i] = Mulaw.enc(frame[i])
                    synchronized(buf) { buf.write(out) }
                }
            } catch (_: Exception) {
            } finally {
                try { rec.stop() } catch (_: Exception) {}
                rec.release()
            }
        }
        vnThread = t
        t.start()
        return true
    }

    /** Stops recording and saves the note. Returns {"ok":true,"id":..,"dur":..} or {"ok":false}. */
    fun vnStop(): String {
        vnOn = false
        try { vnThread?.join(600) } catch (_: Exception) {}
        val buf = vnBuf ?: return "{\"ok\":false}"
        vnBuf = null
        val bytes = synchronized(buf) { buf.toByteArray() }
        if (bytes.size < 4000) return "{\"ok\":false}"
        val id = randomHex(6)
        return try {
            val f = fileFor("vn", id)
            f.parentFile?.mkdirs()
            f.writeBytes(bytes)
            JSONObject().put("ok", true).put("id", id).put("dur", bytes.size / 8000).toString()
        } catch (_: Exception) {
            "{\"ok\":false}"
        }
    }

    fun vnCancel() {
        vnOn = false
        vnBuf = null
    }

    fun vnPlay(mid: String) {
        val f = fileFor("vn", mid)
        if (!f.exists()) return
        vnPlayId = mid
        Thread {
            val rate = 8000
            val minOut = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val track = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
                )
                .setAudioFormat(
                    AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build()
                )
                .setBufferSizeInBytes(maxOf(minOut, 4096))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
            try {
                val data = f.readBytes()
                track.play()
                val pcm = ShortArray(800)
                var pos = 0
                while (vnPlayId == mid && pos < data.size) {
                    val n = minOf(800, data.size - pos)
                    for (i in 0 until n) pcm[i] = Mulaw.dec(data[pos + i])
                    track.write(pcm, 0, n)
                    pos += n
                }
            } catch (_: Exception) {
            } finally {
                try { track.stop() } catch (_: Exception) {}
                track.release()
                if (vnPlayId == mid) vnPlayId = ""
                emit(JSONObject().put("k", "vnend").put("id", mid))
            }
        }.start()
    }

    fun vnStopPlay() {
        vnPlayId = ""
    }

    // ---------------------------------------------------------------- notifications

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < 26) return
        val m = getSystemService(NotificationManager::class.java)
        m.createNotificationChannel(NotificationChannel(CH_MESH, "Mesh running", NotificationManager.IMPORTANCE_LOW))
        m.createNotificationChannel(NotificationChannel(CH_MSG, "Messages", NotificationManager.IMPORTANCE_HIGH))
        m.createNotificationChannel(NotificationChannel(CH_CALL, "Calls", NotificationManager.IMPORTANCE_HIGH))
        m.createNotificationChannel(NotificationChannel(CH_SOS, "SOS alerts", NotificationManager.IMPORTANCE_HIGH))
    }

    private fun openIntent(extraNum: String? = null): PendingIntent {
        val i = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
        if (!extraNum.isNullOrEmpty()) i.putExtra("num", extraNum)
        return PendingIntent.getActivity(
            this, (extraNum ?: "").hashCode(), i,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun buildNotif(): Notification =
        NotificationCompat.Builder(this, CH_MESH)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("NearCall is on")
            .setContentText("${neighbors.size} phone(s) connected nearby")
            .setOngoing(true)
            .setContentIntent(openIntent())
            .build()

    private fun updateNotif() {
        getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildNotif())
    }

    private fun fgs(mic: Boolean) {
        var type = 0
        if (Build.VERSION.SDK_INT >= 29) type = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        if (mic && Build.VERSION.SDK_INT >= 30 && Perms.hasMic(this)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        try {
            ServiceCompat.startForeground(this, NOTIF_ID, buildNotif(), type)
        } catch (_: Exception) {
        }
    }

    /** Respects per-chat mute and quiet hours set in the app. */
    private fun shouldNotify(key: String): Boolean {
        val j = try { JSONObject(p.getString("notif", "{}") ?: "{}") } catch (_: Exception) { JSONObject() }
        val mutedList = j.optJSONArray("muted")
        if (mutedList != null) {
            for (i in 0 until mutedList.length()) if (mutedList.optString(i) == key) return false
        }
        if (j.optBoolean("qon")) {
            val s = j.optInt("qs", 22)
            val e = j.optInt("qe", 7)
            val hr = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
            val inQuiet = if (s <= e) hr in s until e else (hr >= s || hr < e)
            if (inQuiet) return false
        }
        return true
    }

    private fun notifyMessage(key: String, name: String, text: String, openNum: String) {
        val title = if (name.isNotEmpty()) name else key
        val n = NotificationCompat.Builder(this, CH_MSG)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openIntent(openNum))
            .build()
        try { getSystemService(NotificationManager::class.java).notify(100 + (key.hashCode() and 0xFFFF), n) } catch (_: Exception) {}
    }

    private fun notifyIncoming(fromNum: String, name: String) {
        val title = if (name.isNotEmpty()) name else fromNum
        val n = NotificationCompat.Builder(this, CH_CALL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Incoming call")
            .setContentText(title)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setAutoCancel(true)
            .setContentIntent(openIntent())
            .build()
        try { getSystemService(NotificationManager::class.java).notify(3, n) } catch (_: Exception) {}
    }

    private fun cancelNotif(id: Int) {
        try { getSystemService(NotificationManager::class.java).cancel(id) } catch (_: Exception) {}
    }

    // ---------------------------------------------------------------- events

    fun emit(o: JSONObject) {
        val k = o.optString("k")
        val s = sink
        if (s != null) {
            try { s(o.toString()) } catch (_: Exception) {}
        } else if (k == "msg" || k == "ack" || k == "relayed" || k == "blob" || k == "chmsg" || k == "sos" || k == "missed" ||
            (k == "call" && o.optString("reason") == "missed")
        ) {
            persist(this, o)
        }
    }

    // ---------------------------------------------------------------- helpers

    private fun randomHex(bytes: Int): String {
        val sb = StringBuilder()
        repeat(bytes) { sb.append("%02x".format(Random.nextInt(256))) }
        return sb.toString()
    }

    private fun hexToBytes(s: String): ByteArray {
        val out = ByteArray(4)
        for (i in 0 until 4) {
            out[i] = if (s.length >= i * 2 + 2) s.substring(i * 2, i * 2 + 2).toInt(16).toByte() else 0
        }
        return out
    }

    private fun bytesToHex(b: ByteArray, off: Int, len: Int): String {
        val sb = StringBuilder()
        for (i in off until off + len) sb.append("%02x".format(b[i].toInt() and 255))
        return sb.toString()
    }
}
