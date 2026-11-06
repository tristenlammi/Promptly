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
    private TextView next;

    private static final String FIELD = " style='display:block;height:100px;width:100%;font-size:26px'";
    private static String page(String inputs) {
        return "<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'></head><body style='margin:0;padding:0'><form action='#' onsubmit='return false'>" + inputs + "</form></body></html>";
    }
    /** What the fills in ConnectionsUiTest need. The ids are what a test taps. */
    private static String formFor(String which) {
        if ("otp".equals(which)) return page("<input id=code name=code type=text inputmode=numeric autocomplete=one-time-code placeholder=code" + FIELD + " oninput=\"E.user(this.value)\" onchange=\"E.user(this.value)\">");
        if ("email".equals(which)) return page("<input id=email name=email type=email autocomplete=username placeholder=email" + FIELD + " oninput=\"E.user(this.value)\" onchange=\"E.user(this.value)\">");
        if ("change".equals(which)) return page(
            "<input id=current name=current-password type=password autocomplete=current-password placeholder=current" + FIELD + " oninput=\"E.pass(this.value)\" onchange=\"E.pass(this.value)\">"
            + "<input id=fresh name=new-password type=password autocomplete=new-password placeholder=new" + FIELD + " oninput=\"E.next(this.value)\" onchange=\"E.next(this.value)\">"
            + "<input id=again name=confirm-password type=password autocomplete=new-password placeholder=again" + FIELD + ">");
        return HTML;
    }

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
        next = new TextView(this);
        next.setContentDescription("web-new-echo");
        box.addView(next);
        WebView web = new WebView(this);
        web.setContentDescription("web");
        web.getSettings().setJavaScriptEnabled(true);
        web.addJavascriptInterface(new Echo(), "E");
        web.setWebViewClient(new WebViewClient());
        box.addView(web, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 900));
        String url = getIntent().getStringExtra("url");
        web.loadDataWithBaseURL(url != null ? url : "https://pwtest.promptly.test/login", formFor(getIntent().getStringExtra("form")), "text/html", "utf-8", null);
    }

    private class Echo {
        @JavascriptInterface public void user(String v) { runOnUiThread(() -> user.setText(v)); }
        @JavascriptInterface public void pass(String v) { runOnUiThread(() -> pass.setText(v)); }
        @JavascriptInterface public void next(String v) { runOnUiThread(() -> next.setText(v)); }
    }
}
