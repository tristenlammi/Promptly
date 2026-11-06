package org.promptly.pwtest;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;

/** A sign-in page in a WebView. The address is whatever the intent says: it never loads from
 *  a network, so "pwtest.promptly.test" is only a label on local HTML. */
public class WebActivity extends Activity {
    private TextView user;
    private TextView pass;

    private static final String HTML = "<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'></head>"
            + "<body style='margin:0;padding:0'><form action='#' onsubmit='return false'>"
            + "<input id=user name=username type=text autocomplete=username placeholder=username style='display:block;height:120px;width:100%;font-size:30px' oninput=\"E.user(this.value)\" onchange=\"E.user(this.value)\">"
            + "<input id=pass name=password type=password autocomplete=current-password placeholder=password style='display:block;height:120px;width:100%;font-size:30px' oninput=\"E.pass(this.value)\" onchange=\"E.pass(this.value)\">"
            + "<input type=hidden name=trap id=trap value=''>"
            + "</form></body></html>";

    @SuppressLint("SetJavaScriptEnabled")
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout box = Ui.column(this);
        user = new TextView(this);
        user.setContentDescription("web-user-echo");
        pass = new TextView(this);
        pass.setContentDescription("web-pass-echo");
        box.addView(user);
        box.addView(pass);
        WebView web = new WebView(this);
        web.setContentDescription("web");
        web.getSettings().setJavaScriptEnabled(true);
        web.addJavascriptInterface(new Echo(), "E");
        web.setWebViewClient(new WebViewClient());
        box.addView(web, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 900));
        String url = getIntent().getStringExtra("url");
        web.loadDataWithBaseURL(url != null ? url : "https://pwtest.promptly.test/login", HTML, "text/html", "utf-8", null);
    }

    private class Echo {
        @JavascriptInterface public void user(String v) { runOnUiThread(() -> user.setText(v)); }
        @JavascriptInterface public void pass(String v) { runOnUiThread(() -> pass.setText(v)); }
    }
}
