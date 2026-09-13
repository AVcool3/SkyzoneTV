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
 * the TV goes straight to its pairing code). Press MENU (☰) on the remote
 * to point it at a different server. Auto-retries if the server is
 * unreachable.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val prefs by lazy { getSharedPreferences("parkcast", MODE_PRIVATE) }

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
                    // Never show the stock "Webpage not available" browser page:
                    // paint a branded connecting screen and retry until it's back.
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
                    view.postDelayed({ view.loadUrl(playerUrl()) }, 5000)
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // Web renderer crashed after hours of playback: rebuild the
                // whole activity instead of showing a dead white screen.
                recreate()
                return true
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

    /** Boot auto-start needs "Display over other apps"; ask until granted. */
    private fun ensureBootPermission() {
        if (Settings.canDrawOverlays(this)) return
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
        if (!base.startsWith("http")) base = "http://$base"
        base = base.trimEnd('/')
        if (!base.endsWith("/player")) base = "$base/player"
        return "$base/"
    }

    private fun promptForUrl() {
        val input = EditText(this).apply {
            hint = "http://192.168.1.50:8080"
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
        return super.onKeyDown(keyCode, event)
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
