package org.promptly.app;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.os.Bundle;
import android.util.TypedValue;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Which apps get a home-screen icon. Promptly itself is always there; each
 * other launcher is switched on or off on the phone (they ship off). Opened
 * after setup — pre-ticked with the apps you use in Promptly when the Install
 * apps page passed them ({@link #EXTRA_APPS}) — and from the Promptly icon's
 * long-press "Choose apps".
 */
public class ChooseAppsActivity extends Activity {
    /** Comma-separated app keys to tick (from the setup link); otherwise what's on now. */
    static final String EXTRA_APPS = "apps";
    /** Open Promptly when done (first-time setup). */
    static final String EXTRA_OPEN_AFTER = "open_after";

    private final List<CheckBox> boxes = new ArrayList<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String wanted = getIntent().getStringExtra(EXTRA_APPS);
        Set<String> tick = wanted == null ? null : new HashSet<>(Arrays.asList(wanted.split(",")));

        int pad = dp(24);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("Choose your apps");
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        box.addView(title);

        TextView hint = new TextView(this);
        hint.setText("Each one gets its own icon on your home screen. Promptly is always there — change this any time: long-press Promptly → Choose apps.");
        hint.setTextColor(Color.parseColor("#A8A29E"));
        hint.setPadding(0, dp(8), 0, dp(12));
        box.addView(hint);

        PackageManager pm = getPackageManager();
        for (String[] app : Apps.ALL) {
            CheckBox cb = new CheckBox(this);
            cb.setText(app[1]);
            cb.setTextColor(Color.WHITE);
            cb.setButtonTintList(ColorStateList.valueOf(Color.parseColor("#D97757")));
            cb.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
            cb.setPadding(dp(8), dp(10), 0, dp(10));
            cb.setTag(app[2]);
            cb.setChecked(tick != null ? tick.contains(app[0]) : isOn(pm, app[2]));
            boxes.add(cb);
            box.addView(cb);
        }

        Button done = new Button(this);
        done.setText("Done");
        done.setOnClickListener(v -> save());
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(16);
        box.addView(done, lp);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.parseColor("#1C1917"));
        scroll.setFitsSystemWindows(true);
        scroll.addView(box);
        setContentView(scroll);
    }

    private boolean isOn(PackageManager pm, String cls) {
        ComponentName name = new ComponentName(this, cls);
        int state = pm.getComponentEnabledSetting(name);
        if (state != PackageManager.COMPONENT_ENABLED_STATE_DEFAULT) {
            return state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED;
        }
        // Never changed: what the manifest says (Passwords starts on, the web apps off).
        try {
            return pm.getActivityInfo(name, PackageManager.MATCH_DISABLED_COMPONENTS).enabled;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    private void save() {
        PackageManager pm = getPackageManager();
        for (CheckBox cb : boxes) {
            pm.setComponentEnabledSetting(
                    new ComponentName(this, (String) cb.getTag()),
                    cb.isChecked() ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                                   : PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                    PackageManager.DONT_KILL_APP);
        }
        if (getIntent().getBooleanExtra(EXTRA_OPEN_AFTER, false)) {
            startActivity(new Intent(this, PromptlyLauncher.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        finish();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
