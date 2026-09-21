package com.parkcast.player

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import androidx.appcompat.app.AppCompatActivity

/**
 * Full-screen kiosk WebView that loads the ParkCast player page.
 * Connects to the built-in server address on first boot (no setup screen —
 * the TV goes straight to its pairing code). Long-press OK/Select (or press
 * MENU on remotes that have it) to point it at a different server.
 * Auto-retries if the server is unreachable. Pressing BACK three times
 * quickly offers a real exit — Play's TV review requires that BACK can
 * always lead home, kiosk or not.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val prefs by lazy { getSharedPreferences("parkcast", MODE_PRIVATE) }
    private var loadWatchdog: Runnable? = null
    private var backCount = 0
    private var lastBackAt = 0L

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        webView = WebView(this)
        setContentView(webView)
        hideSystemUi()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true            // localStorage keeps the TV's identity
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
        }
        webView.setBackgroundColor(android.graphics.Color.BLACK)
        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(
                view: WebView, request: WebResourceRequest, error: WebResourceError
            ) {
                if (request.isForMainFrame) {
                    showConnecting(view)
                    view.postDelayed({ view.loadUrl(playerUrl()) }, 5000)
                }
            }

            // Never show a stock browser error page: paint a branded
            // connecting screen and retry until the server is back.
            private fun showConnecting(view: WebView) {
                view.loadDataWithBaseURL(
                    null,
                    """<!DOCTYPE html><html><body style="margin:0;background:#000;height:100vh;
                       display:flex;flex-direction:column;align-items:center;justify-content:center;
                       font-family:sans-serif;color:#fff">
                       <div style="font-size:8vmin;font-weight:800;letter-spacing:.04em">
                         PARK<span style="color:#ff6a00">CAST</span></div>
                       <div style="font-size:3vmin;color:#9aa0b4;margin-top:3vmin">Connecting…</div>
                       </body></html>""",
                    "text/html", "utf-8", null
                )
            }

            override fun onReceivedHttpError(
                view: WebView, request: WebResourceRequest, errorResponse: android.webkit.WebResourceResponse
            ) {
                // A 502/503 mid-deploy would otherwise sit on screen as a raw
                // error page until someone power-cycles the TV.
                if (request.isForMainFrame) {
                    showConnecting(view)
                    view.postDelayed({ view.loadUrl(playerUrl()) }, 5000)
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // Web renderer crashed after hours of playback: rebuild the
                // whole activity instead of showing a dead white screen.
                recreate()
                return true
            }

            // A server that accepts the connection but never answers would
            // leave the screen black indefinitely — after 20s of loading,
            // fall back to the branded connecting screen and retry.
            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                loadWatchdog?.let { view.removeCallbacks(it) }
                val w = Runnable {
                    showConnecting(view)
                    view.postDelayed({ view.loadUrl(playerUrl()) }, 5000)
                }
                loadWatchdog = w
                view.postDelayed(w, 20000)
            }

            override fun onPageFinished(view: WebView, url: String?) {
                loadWatchdog?.let { view.removeCallbacks(it) }
                loadWatchdog = null
            }
        }

        // First boot: connect straight to the built-in server — no setup
        // screen between plugging in and the pairing code. MENU (☰) still
        // opens the address dialog to point the screen elsewhere.
        if (prefs.getString("serverUrl", null) == null) {
            prefs.edit().putString("serverUrl", BuildConfig.DEFAULT_SERVER_URL).apply()
        }
        webView.loadUrl(playerUrl())
        ensureBootPermission()
    }

    /** Boot auto-start needs "Display over other apps". Fire OS 5 (API 22)
     *  predates both the permission and the API — skip there. Ask once, not
     *  on every launch: a public screen must not show a dialog nightly. */
    private fun ensureBootPermission() {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.M) return
        if (Settings.canDrawOverlays(this)) return
        if (prefs.getBoolean("bootPermAsked", false)) return
        prefs.edit().putBoolean("bootPermAsked", true).apply()
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.boot_title))
            .setMessage(getString(R.string.boot_message))
            .setPositiveButton(getString(R.string.boot_open)) { _, _ ->
                try {
                    startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
                } catch (e: Exception) {
                    try { startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)) } catch (_: Exception) {}
                }
            }
            .setNegativeButton(getString(R.string.boot_later), null)
            .show()
    }

    private fun playerUrl(): String {
        var base = prefs.getString("serverUrl", "") ?: ""
        // No scheme typed -> assume HTTPS; cleartext only happens when an
        // operator deliberately enters http:// for a LAN server.
        if (!base.startsWith("http")) base = "https://$base"
        base = base.trimEnd('/')
        if (!base.endsWith("/player")) base = "$base/player"
        return "$base/"
    }

    private fun promptForUrl() {
        val input = EditText(this).apply {
            hint = getString(R.string.setup_hint)
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(prefs.getString("serverUrl", ""))
        }
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.setup_title))
            .setMessage(getString(R.string.setup_message))
            .setView(input)
            .setCancelable(prefs.contains("serverUrl"))
            .setPositiveButton(getString(R.string.setup_connect)) { _, _ ->
                prefs.edit().putString("serverUrl", input.text.toString().trim()).apply()
                webView.loadUrl(playerUrl())
            }
            .show()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            promptForUrl()
            return true
        }
        // Google TV remotes have no MENU button: long-pressing OK/Select is
        // the always-available way into the server-address dialog.
        if (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER) {
            event?.startTracking()
            return true // the player page is display-only; nothing needs the press
        }
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            // Kiosk: one stray BACK mid-shift is ignored, but three quick
            // presses offer a real exit — TV review requires that BACK can
            // always lead back to the Android TV home screen.
            val now = android.os.SystemClock.uptimeMillis()
            if (now - lastBackAt > 2000) backCount = 0
            lastBackAt = now
            if (++backCount >= 3) {
                backCount = 0
                confirmExit()
            }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyLongPress(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER) {
            promptForUrl()
            return true
        }
        return super.onKeyLongPress(keyCode, event)
    }

    private fun confirmExit() {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.exit_title))
            .setMessage(getString(R.string.exit_message))
            // "Keep playing" is the positive (default-focused) choice so an
            // accidental OK press never blanks a venue screen.
            .setPositiveButton(getString(R.string.exit_keep), null)
            .setNegativeButton(getString(R.string.exit_confirm)) { _, _ -> finishAndRemoveTask() }
            .show()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemUi()
    }

    private fun hideSystemUi() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            )
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }
}
