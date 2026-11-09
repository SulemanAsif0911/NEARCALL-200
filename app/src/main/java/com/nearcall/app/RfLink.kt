package com.nearcall.app

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import java.io.DataInputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import kotlin.random.Random

/**
 * Direct Bluetooth link (RFCOMM) to phones that are PAIRED with this one.
 *
 * It does not touch Wi-Fi at all: turning Wi-Fi off cannot break it, and its problems cannot break the Wi-Fi link.
 * Pair the phones once in Android's Bluetooth settings; after that NearCall connects by itself in about a second,
 * with no searching, and keeps reconnecting if the link drops.
 *
 * Frames on the wire: 2-byte length + payload (the same payload bytes the other links carry).
 * Each side first sends a hello frame: 0x48 + its 4-byte node id.
 */
class RfLink(
    private val nodeId: ByteArray,
    private val onUp: (String, ByteArray) -> Unit,
    private val onData: (String, ByteArray) -> Unit,
    private val onDown: (String) -> Unit
) {
    companion object {
        val SERVICE: UUID = UUID.fromString("5d1c6f0a-8a3e-4b8e-9a53-6e656172636c")
        const val HELLO: Byte = 0x48
    }

    private val links = ConcurrentHashMap<String, Conn>()
    private val connecting = ConcurrentHashMap.newKeySet<String>()
    private val nextTry = ConcurrentHashMap<String, Long>()
    private val fails = ConcurrentHashMap<String, Int>()
    @Volatile private var running = false
    @Volatile private var server: BluetoothServerSocket? = null

    fun start() {
        running = true
        startServer()
    }

    fun stop() {
        running = false
        try { server?.close() } catch (_: Exception) {}
        server = null
        for (c in links.values.toList()) c.close()
        connecting.clear()
    }

    /** After Bluetooth was switched off and on. */
    fun restart() {
        val was = running
        stop()
        nextTry.clear()
        if (was) start()
    }

    /** "Reconnect now": forget the back-off and try every paired phone straight away. */
    fun retryNow() {
        nextTry.clear()
        tryConnectAll()
    }

    fun send(ep: String, bytes: ByteArray) {
        links[ep]?.send(bytes)
    }

    fun close(ep: String) {
        links[ep]?.close()
    }

    @SuppressLint("MissingPermission")
    private fun startServer() {
        if (!running || server != null) return
        val ad = try { BluetoothAdapter.getDefaultAdapter() } catch (_: Exception) { null } ?: return
        if (!ad.isEnabled) return
        Thread {
            try {
                val ss = ad.listenUsingInsecureRfcommWithServiceRecord("NearCall", SERVICE)
                server = ss
                while (running) {
                    val s = ss.accept()
                    attach(s)
                }
            } catch (_: Exception) {
            } finally {
                try { server?.close() } catch (_: Exception) {}
                server = null
            }
        }.start()
    }

    /** Called every few seconds by the service: connect to every paired phone we are not connected to. */
    @SuppressLint("MissingPermission")
    fun tryConnectAll() {
        if (!running) return
        val ad = try { BluetoothAdapter.getDefaultAdapter() } catch (_: Exception) { null } ?: return
        if (!ad.isEnabled) return
        startServer()
        val bonded = try { ad.bondedDevices } catch (_: Exception) { null } ?: return
        val now = System.currentTimeMillis()
        for (d in bonded) {
            val mac = d.address ?: continue
            val ep = "rf:$mac"
            if (links.containsKey(ep) || connecting.contains(mac)) continue
            // only phones / computers: never poke headphones, watches or cars
            val mc = try { d.bluetoothClass?.majorDeviceClass } catch (_: Exception) { null }
            if (mc != null && mc != BluetoothClass.Device.Major.PHONE &&
                mc != BluetoothClass.Device.Major.UNCATEGORIZED && mc != BluetoothClass.Device.Major.COMPUTER
            ) continue
            if (now < (nextTry[mac] ?: 0L)) continue
            connecting.add(mac)
            Thread {
                try {
                    Thread.sleep(Random.nextLong(0, 900))   // so two phones rarely connect to each other at the same instant
                    if (!links.containsKey(ep)) {
                        try { ad.cancelDiscovery() } catch (_: Exception) {}
                        val s = d.createInsecureRfcommSocketToServiceRecord(SERVICE)
                        s.connect()
                        fails.remove(mac)
                        attach(s)
                    }
                } catch (_: Exception) {
                    // 8 s, 16 s, 32 s ... up to 2 min between tries for a phone that is away or has no NearCall
                    val f = (fails[mac] ?: 0) + 1
                    fails[mac] = f
                    nextTry[mac] = System.currentTimeMillis() + minOf(8000L shl minOf(f - 1, 4), 120000L)
                } finally {
                    connecting.remove(mac)
                }
            }.start()
        }
    }

    @SuppressLint("MissingPermission")
    private fun attach(s: BluetoothSocket) {
        val mac = try { s.remoteDevice.address } catch (_: Exception) { null }
        if (mac == null) {
            try { s.close() } catch (_: Exception) {}
            return
        }
        val ep = "rf:$mac"
        val c = Conn(s, ep)
        if (links.putIfAbsent(ep, c) != null) {
            // already connected to this phone (both sides dialled at once): keep the first, drop this one
            try { s.close() } catch (_: Exception) {}
            return
        }
        fails.remove(mac)
        c.start()
    }

    private inner class Conn(val sock: BluetoothSocket, val ep: String) {
        private val q = LinkedBlockingQueue<ByteArray>()
        @Volatile private var alive = true
        private var upSent = false

        fun start() {
            Thread {
                try {
                    val out = sock.outputStream
                    writeFrame(out, byteArrayOf(HELLO) + nodeId)
                    while (alive) {
                        val b = q.take()
                        if (!alive) break
                        writeFrame(out, b)
                    }
                } catch (_: Exception) {
                    close()
                }
            }.start()
            Thread {
                try {
                    val inp = DataInputStream(sock.inputStream)
                    while (alive) {
                        val len = inp.readUnsignedShort()
                        if (len == 0) continue
                        val buf = ByteArray(len)
                        inp.readFully(buf)
                        if (!upSent && len >= 5 && buf[0] == HELLO) {
                            upSent = true
                            onUp(ep, buf.copyOfRange(1, 5))
                        } else {
                            onData(ep, buf)
                        }
                    }
                } catch (_: Exception) {
                    close()
                }
            }.start()
        }

        fun send(b: ByteArray) {
            if (alive && b.size <= 65535) q.offer(b)
        }

        private fun writeFrame(out: java.io.OutputStream, b: ByteArray) {
            val f = ByteArray(b.size + 2)
            f[0] = (b.size shr 8).toByte()
            f[1] = b.size.toByte()
            System.arraycopy(b, 0, f, 2, b.size)
            out.write(f)
            out.flush()
        }

        fun close() {
            if (!alive) return
            alive = false
            try { sock.close() } catch (_: Exception) {}
            links.remove(ep, this)
            q.offer(ByteArray(0))
            onDown(ep)
        }
    }
}
