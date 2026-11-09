package com.nearcall.app

import android.content.Context
import android.net.wifi.WifiManager
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.util.concurrent.Executors

/**
 * Second link type: plain UDP over whatever Wi-Fi the phone is on (a friend's hotspot, a router,
 * or the phone's own hotspot). Wi-Fi reaches further and carries more than Bluetooth, and the mesh
 * treats these peers exactly like Bluetooth neighbours, so one phone can bridge both.
 *
 * Datagram = 'N' 'C' + payload (same bytes Nearby carries), or 'N' 'C' 'H' + 4-byte node id (discovery).
 */
class LanLink(
    private val ctx: Context,
    private val nodeId: ByteArray,
    private val onData: (String, ByteArray) -> Unit,
    private val onHello: (String, ByteArray) -> Unit
) {
    companion object {
        const val PORT = 45454
        const val M0: Byte = 0x4E
        const val M1: Byte = 0x43
        const val HELLO: Byte = 0x48
    }

    @Volatile private var sock: DatagramSocket? = null
    private var lock: WifiManager.MulticastLock? = null
    private val exec = Executors.newSingleThreadExecutor()

    fun start() {
        if (sock != null) return
        try {
            val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val l = wm.createMulticastLock("nearcall")
            l.setReferenceCounted(false)
            l.acquire()
            lock = l
            val s = DatagramSocket(null)
            s.reuseAddress = true
            s.broadcast = true
            s.bind(InetSocketAddress(PORT))
            sock = s
            Thread {
                val buf = ByteArray(65535)
                while (!s.isClosed) {
                    try {
                        val pk = DatagramPacket(buf, buf.size)
                        s.receive(pk)
                        val len = pk.length
                        if (len < 3 || buf[0] != M0 || buf[1] != M1) continue
                        val ip = pk.address?.hostAddress ?: continue
                        if (buf[2] == HELLO) {
                            if (len >= 7) onHello(ip, buf.copyOfRange(3, 7))
                        } else {
                            onData(ip, buf.copyOfRange(2, len))
                        }
                    } catch (e: Exception) {
                        if (s.isClosed) break
                        try { Thread.sleep(50) } catch (_: Exception) {}
                    }
                }
            }.start()
        } catch (e: Exception) {
            sock = null
        }
    }

    fun stop() {
        try { sock?.close() } catch (_: Exception) {}
        sock = null
        try { lock?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
        lock = null
    }

    /** Unicast to one peer. Done off the main thread because sockets are not allowed there. */
    fun sendTo(ip: String, payload: ByteArray) {
        val s = sock ?: return
        exec.execute {
            try {
                val d = ByteArray(payload.size + 2)
                d[0] = M0
                d[1] = M1
                System.arraycopy(payload, 0, d, 2, payload.size)
                s.send(DatagramPacket(d, d.size, InetAddress.getByName(ip), PORT))
            } catch (_: Exception) {
            }
        }
    }

    /** Some hotspots and routers drop broadcasts, so also knock on every address of the local /24. */
    fun sweep() {
        val s = sock ?: return
        exec.execute {
            val d = ByteArray(7)
            d[0] = M0
            d[1] = M1
            d[2] = HELLO
            System.arraycopy(nodeId, 0, d, 3, 4)
            try {
                val en = NetworkInterface.getNetworkInterfaces()
                while (en != null && en.hasMoreElements()) {
                    val ni = en.nextElement()
                    if (!ni.isUp || ni.isLoopback) continue
                    val n = ni.name ?: ""
                    if (n.startsWith("rmnet") || n.startsWith("ccmni") || n.startsWith("tun") || n.startsWith("dummy")) continue
                    for (ia in ni.interfaceAddresses) {
                        val raw = ia.address?.address ?: continue
                        if (raw.size != 4) continue
                        val me = raw[3].toInt() and 255
                        for (host in 1..254) {
                            if (host == me) continue
                            val t = byteArrayOf(raw[0], raw[1], raw[2], host.toByte())
                            try { s.send(DatagramPacket(d, d.size, InetAddress.getByAddress(t), PORT)) } catch (_: Exception) {}
                        }
                    }
                }
            } catch (_: Exception) {
            }
        }
    }

    /** Shout "I'm here" on every Wi-Fi / hotspot network this phone is part of. */
    fun broadcastHello() {
        val s = sock ?: return
        exec.execute {
            val d = ByteArray(7)
            d[0] = M0
            d[1] = M1
            d[2] = HELLO
            System.arraycopy(nodeId, 0, d, 3, 4)
            val done = HashSet<String>()
            try {
                val en = NetworkInterface.getNetworkInterfaces()
                while (en != null && en.hasMoreElements()) {
                    val ni = en.nextElement()
                    if (!ni.isUp || ni.isLoopback) continue
                    val n = ni.name ?: ""
                    if (n.startsWith("rmnet") || n.startsWith("ccmni") || n.startsWith("tun") || n.startsWith("dummy")) continue
                    for (ia in ni.interfaceAddresses) {
                        val b = ia.broadcast ?: continue
                        val ip = b.hostAddress ?: continue
                        if (done.add(ip)) {
                            try { s.send(DatagramPacket(d, d.size, b, PORT)) } catch (_: Exception) {}
                        }
                    }
                }
            } catch (_: Exception) {
            }
            try { s.send(DatagramPacket(d, d.size, InetAddress.getByName("255.255.255.255"), PORT)) } catch (_: Exception) {}
        }
    }
}
