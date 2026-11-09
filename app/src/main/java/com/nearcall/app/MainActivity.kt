package com.nearcall.app

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.File

/**
 * Same shell format as the other apps: a native Kotlin host that serves assets/www
 * inside a WebView (https://appassets.androidplatform.net) and talks to it through
 * the `AndroidNative` JavaScript bridge. All Bluetooth / Wi-Fi mesh work lives in MeshService.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private lateinit var root: FrameLayout
    private var insets = intArrayOf(0, 0, 0, 0)
    private var pageReady = false
    private var pendingOpen: String? = null
    private var pendingMid = ""
    private var pendingBackup = ""

    private val permLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            js("window.onPerms&&onPerms(${Perms.hasNearby(this)})")
        }

    private val imgLauncher =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            val mid = pendingMid
            if (uri == null) {
                js("window.onImage&&onImage(${JSONObject.quote(mid)},false)")
            } else {
                Thread {
                    val ok = saveImage(uri, mid)
                    runOnUiThread { js("window.onImage&&onImage(${JSONObject.quote(mid)},$ok)") }
                }.start()
            }
        }

    private val backupLauncher =
        registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
            if (uri != null) {
                try {
                    contentResolver.openOutputStream(uri)?.use { it.write(pendingBackup.toByteArray(Charsets.UTF_8)) }
                    Toast.makeText(this, "Backup saved", Toast.LENGTH_SHORT).show()
                } catch (e: Exception) {
                    Toast.makeText(this, "Could not save backup", Toast.LENGTH_SHORT).show()
                }
            }
            pendingBackup = ""
        }

    private val restoreLauncher =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            if (uri != null) {
                try {
                    val text = contentResolver.openInputStream(uri)?.use { String(it.readBytes(), Charsets.UTF_8) } ?: ""
                    js("window.onRestore&&onRestore(${JSONObject.quote(text)})")
                } catch (e: Exception) {
                    Toast.makeText(this, "Could not read backup", Toast.LENGTH_SHORT).show()
                }
            }
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT

        root = FrameLayout(this)
        root.setBackgroundColor(0xFF0B3B36.toInt())
        web = WebView(this)
        web.setBackgroundColor(Color.TRANSPARENT)
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)

        WindowCompat.getInsetsController(window, root).isAppearanceLightStatusBars = false

        // Pass system-bar insets to the page (CSS px) and shrink for the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, ins ->
            val bars = ins.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = ins.getInsets(WindowInsetsCompat.Type.ime()).bottom
            val d = resources.displayMetrics.density
            v.setPadding(0, 0, 0, ime)
            val bottom = if (ime > 0) 0 else bars.bottom
            insets = intArrayOf((bars.top / d).toInt(), (bars.right / d).toInt(), (bottom / d).toInt(), (bars.left / d).toInt())
            pushInsets()
            ins
        }

        // photos and voice notes live in files/media and are shown through /media/ on the same origin
        val mdir = MeshService.mediaDir(this)
        File(mdir, "img").mkdirs()
        File(mdir, "vn").mkdirs()
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/media/", WebViewAssetLoader.InternalStoragePathHandler(this, mdir))
            .build()

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.host != "appassets.androidplatform.net"

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                pushInsets()
                flushOpen()
            }
        }
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
        }
        web.addJavascriptInterface(Bridge(), "AndroidNative")
        web.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(window.onBack&&onBack())?1:0") { r ->
                    // not handled by the page: hide the app but keep the mesh running
                    if (r != "1") moveTaskToBack(true)
                }
            }
        })
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(i: Intent?) {
        val n = i?.getStringExtra("num") ?: return
        pendingOpen = n
        i.removeExtra("num")
        flushOpen()
    }

    private fun flushOpen() {
        val n = pendingOpen ?: return
        if (!pageReady) return
        pendingOpen = null
        js("window.onOpenPeer&&onOpenPeer(${JSONObject.quote(n)})")
    }

    override fun onResume() {
        super.onResume()
        MeshService.sink = { s -> runOnUiThread { js("window.onMesh&&onMesh($s)") } }
        if (pageReady) js("window.onNativeResume&&onNativeResume()")
        flushOpen()
    }

    override fun onPause() {
        MeshService.sink = null
        if (pageReady) js("window.onNativePause&&onNativePause()")
        super.onPause()
    }

    override fun onDestroy() {
        MeshService.sink = null
        web.destroy()
        super.onDestroy()
    }

    private fun js(code: String) {
        web.evaluateJavascript(code, null)
    }

    private fun pushInsets() {
        if (!::web.isInitialized) return
        js("window.CH_setInsets&&CH_setInsets(${insets[0]},${insets[1]},${insets[2]},${insets[3]})")
    }

    private fun prefs() = MeshService.prefs(this)

    /** Shrinks the picked photo to 640 px JPEG (about 40-80 KB) so it travels well over Bluetooth. */
    private fun saveImage(uri: Uri, mid: String): Boolean {
        return try {
            val m = MeshService.safe(mid)
            if (m.isEmpty()) return false
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
            var sample = 1
            val big = maxOf(bounds.outWidth, bounds.outHeight)
            while (big / sample > 1280) sample *= 2
            val opts = BitmapFactory.Options().apply { inSampleSize = sample }
            val bmp = contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) } ?: return false
            val scale = 640f / maxOf(bmp.width, bmp.height)
            var out: Bitmap = if (scale < 1f) {
                Bitmap.createScaledBitmap(
                    bmp, (bmp.width * scale).toInt().coerceAtLeast(1), (bmp.height * scale).toInt().coerceAtLeast(1), true
                )
            } else bmp
            val orient = try {
                contentResolver.openInputStream(uri)?.use {
                    ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
                } ?: ExifInterface.ORIENTATION_NORMAL
            } catch (e: Exception) {
                ExifInterface.ORIENTATION_NORMAL
            }
            val deg = when (orient) {
                ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                else -> 0f
            }
            if (deg != 0f) {
                val mx = Matrix()
                mx.postRotate(deg)
                out = Bitmap.createBitmap(out, 0, 0, out.width, out.height, mx, true)
            }
            val dir = File(MeshService.mediaDir(this), "img")
            dir.mkdirs()
            File(dir, "$m.jpg").outputStream().use { out.compress(Bitmap.CompressFormat.JPEG, 60, it) }
            true
        } catch (e: Exception) {
            false
        }
    }

    /** Everything the page can call. Only our own bundled pages are ever loaded, so this is not exposed to the web. */
    inner class Bridge {
        @JavascriptInterface fun getInsets(): String = insets.joinToString(",")

        // permissions
        @JavascriptInterface fun hasPerms(): Boolean = Perms.hasNearby(this@MainActivity)
        @JavascriptInterface fun hasMic(): Boolean = Perms.hasMic(this@MainActivity)

        @JavascriptInterface fun requestPerms() {
            runOnUiThread {
                val need = Perms.all().filter { !Perms.has(this@MainActivity, it) }
                if (need.isEmpty()) js("window.onPerms&&onPerms(true)")
                else permLauncher.launch(need.toTypedArray())
            }
        }

        // service
        @JavascriptInterface fun start(num: String, name: String, av: Int): Boolean {
            if (!Perms.hasNearby(this@MainActivity)) return false
            prefs().edit().putString("num", num).putString("name", name).putInt("av", av).putBoolean("auto", true).apply()
            val s = MeshService.instance
            if (s == null) MeshService.start(this@MainActivity) else s.reload()
            return true
        }

        @JavascriptInterface fun stop() {
            prefs().edit().putBoolean("auto", false).apply()
            MeshService.stop(this@MainActivity)
            js("window.onMesh&&onMesh({k:'status',running:false})")
        }

        @JavascriptInterface fun isRunning(): Boolean = MeshService.instance != null
        @JavascriptInterface fun snapshot() { MeshService.instance?.emitPeers() }
        @JavascriptInterface fun drain(): String = MeshService.drain(this@MainActivity)
        @JavascriptInterface fun callState(): String = MeshService.instance?.callJson() ?: "{\"k\":\"call\",\"state\":\"idle\"}"
        @JavascriptInterface fun netInfo(): String = MeshService.instance?.netInfo() ?: "{}"

        // messaging
        @JavascriptInterface fun send(num: String, mid: String, text: String, rp: String, via: String) { MeshService.instance?.sendText(num, mid, text, rp, via) }
        @JavascriptInterface fun sendFile(num: String, mid: String, kind: String, dur: Int, via: String) { MeshService.instance?.sendFile(num, mid, kind, dur, via) }
        @JavascriptInterface fun joinChannel(name: String) { MeshService.instance?.joinChannel(name) }
        @JavascriptInterface fun leaveChannel(name: String) { MeshService.instance?.leaveChannel(name) }
        @JavascriptInterface fun sendChannel(name: String, mid: String, text: String) { MeshService.instance?.sendChannel(name, mid, text) }
        @JavascriptInterface fun sos(text: String) { MeshService.instance?.sendSos(text) }
        @JavascriptInterface fun ping(num: String) { MeshService.instance?.ping(num) }
        @JavascriptInterface fun block(num: String, on: Boolean) { MeshService.instance?.setBlocked(num, on) }
        @JavascriptInterface fun trust(num: String) { MeshService.instance?.trust(num) }

        // calls
        @JavascriptInterface fun call(num: String, via: String) { MeshService.instance?.startCall(num, via) }
        @JavascriptInterface fun accept() { MeshService.instance?.acceptCall() }
        @JavascriptInterface fun reject() { MeshService.instance?.rejectCall() }
        @JavascriptInterface fun end() { MeshService.instance?.endCall() }
        @JavascriptInterface fun mute(on: Boolean) { MeshService.instance?.setMute(on) }
        @JavascriptInterface fun speaker(on: Boolean) { MeshService.instance?.setSpeaker(on) }

        // voice notes and photos
        @JavascriptInterface fun vnStart(): Boolean = MeshService.instance?.vnStart() ?: false
        @JavascriptInterface fun vnStop(): String = MeshService.instance?.vnStop() ?: "{\"ok\":false}"
        @JavascriptInterface fun vnCancel() { MeshService.instance?.vnCancel() }
        @JavascriptInterface fun vnPlay(mid: String) { MeshService.instance?.vnPlay(mid) }
        @JavascriptInterface fun vnStopPlay() { MeshService.instance?.vnStopPlay() }

        @JavascriptInterface fun pickImage(mid: String) {
            pendingMid = mid
            runOnUiThread { imgLauncher.launch("image/*") }
        }

        // settings
        @JavascriptInterface fun setRelay(on: Boolean) {
            prefs().edit().putBoolean("relay", on).apply()
            MeshService.instance?.setRelay(on)
        }

        @JavascriptInterface fun reconnect() { MeshService.instance?.reconnectNow() }

        @JavascriptInterface fun setContactsOnly(on: Boolean) {
            prefs().edit().putBoolean("conly", on).apply()
            MeshService.instance?.setContactsOnly(on)
        }

        @JavascriptInterface fun setAllowed(json: String) {
            prefs().edit().putString("allowed", json).apply()
            MeshService.instance?.setAllowed(json)
        }

        /** This install's fingerprint (12 hex of its public key). The key is created here if it does not exist yet. */
        @JavascriptInterface fun identity(): String {
            val c = Crypto(MeshService.prefs(this@MainActivity))
            return JSONObject().put("fp", Crypto.fp(c.pubB64)).toString()
        }

        @JavascriptInterface fun joinChannelPw(name: String, pass: String) { MeshService.instance?.joinChannelPw(name, pass) }

        @JavascriptInterface fun wipe() {
            val s = MeshService.instance
            if (s != null) {
                s.wipe()
            } else {
                MeshService.prefs(this@MainActivity).edit().clear().commit()
                try { MeshService.mediaDir(this@MainActivity).deleteRecursively() } catch (_: Exception) {}
            }
        }

        @JavascriptInterface fun setNearby(on: Boolean) {
            prefs().edit().putBoolean("nb", on).apply()
            MeshService.instance?.setNearby(on)
        }

        @JavascriptInterface fun openBluetooth() {
            runOnUiThread {
                try {
                    startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
                } catch (e: Exception) {
                    startActivity(Intent(Settings.ACTION_SETTINGS))
                }
            }
        }

        @JavascriptInterface fun setBt(on: Boolean) {
            prefs().edit().putBoolean("bt", on).apply()
            MeshService.instance?.setBt(on)
        }

        @JavascriptInterface fun setLan(on: Boolean) {
            prefs().edit().putBoolean("lan", on).apply()
            MeshService.instance?.setLan(on)
        }

        @JavascriptInterface fun setNotify(json: String) {
            prefs().edit().putString("notif", json).apply()
        }

        @JavascriptInterface fun secure(on: Boolean) {
            runOnUiThread {
                if (on) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
        }

        @JavascriptInterface fun copy(text: String) {
            runOnUiThread {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("NearCall", text))
            }
        }

        @JavascriptInterface fun backup(json: String) {
            pendingBackup = json
            runOnUiThread { backupLauncher.launch("nearcall-backup.json") }
        }

        @JavascriptInterface fun restore() {
            runOnUiThread { restoreLauncher.launch("*/*") }
        }

        /** Sends this app's own APK through the system share sheet (Bluetooth, Nearby Share, WhatsApp...). */
        @JavascriptInterface fun shareApk() {
            runOnUiThread {
                try {
                    val dir = File(cacheDir, "share")
                    dir.mkdirs()
                    val out = File(dir, "NearCall.apk")
                    File(applicationInfo.sourceDir).copyTo(out, true)
                    val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.files", out)
                    val i = Intent(Intent.ACTION_SEND)
                        .setType("application/vnd.android.package-archive")
                        .putExtra(Intent.EXTRA_STREAM, uri)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    startActivity(Intent.createChooser(i, "Share NearCall"))
                } catch (e: Exception) {
                    Toast.makeText(this@MainActivity, "Could not share the app", Toast.LENGTH_SHORT).show()
                }
            }
        }

        @JavascriptInterface fun openHotspot() {
            runOnUiThread {
                try {
                    startActivity(Intent(Settings.ACTION_WIRELESS_SETTINGS))
                } catch (e: Exception) {
                    startActivity(Intent(Settings.ACTION_SETTINGS))
                }
            }
        }

        @JavascriptInterface fun openWifi() {
            runOnUiThread {
                try {
                    startActivity(Intent(Settings.ACTION_WIFI_SETTINGS))
                } catch (e: Exception) {
                    startActivity(Intent(Settings.ACTION_SETTINGS))
                }
            }
        }

        @JavascriptInterface fun batteryOk(): Boolean {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            return pm.isIgnoringBatteryOptimizations(packageName)
        }

        @JavascriptInterface fun batterySettings() {
            runOnUiThread {
                try {
                    startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                } catch (e: Exception) {
                    startActivity(Intent(Settings.ACTION_SETTINGS))
                }
            }
        }
    }
}
