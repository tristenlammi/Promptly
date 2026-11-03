package org.promptly.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Which Promptly server this phone uses. Filled in for you when you tap
 * "Set up the app" on your server's Install apps page
 * ({@code promptlyapp://setup?server=https://…&apps=rooms,workout}); otherwise
 * typed once here. A new phone then picks its apps ({@link ChooseAppsActivity}).
 * Also reachable later from the Promptly icon's long-press "Change server".
 */
public class SetupActivity extends Activity {
    static final String EXTRA_THEN = "then";

    private EditText address;
    private TextView error;
    /** The apps you use in Promptly, from the setup link — pre-ticked in the picker. */
    private String apps;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Uri link = getIntent().getData();
        if (link != null && "setup".equals(link.getHost())) {
            String origin = Server.normalise(link.getQueryParameter("server"));
            if (origin != null) {
                apps = link.getQueryParameter("apps");
                done(origin);
                return;
            }
        }
        buildForm();
    }

    private void buildForm() {
        int pad = dp(24);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        box.setPadding(pad, pad, pad, pad);
        box.setBackgroundColor(Color.parseColor("#1C1917"));

        TextView title = new TextView(this);
        title.setText("Your Promptly address");
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        box.addView(title);

        TextView hint = new TextView(this);
        hint.setText("The web address you open Promptly at, e.g. promptly.example.com");
        hint.setTextColor(Color.parseColor("#A8A29E"));
        hint.setPadding(0, dp(8), 0, dp(16));
        box.addView(hint);

        address = new EditText(this);
        address.setSingleLine(true);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setImeOptions(EditorInfo.IME_ACTION_DONE);
        address.setTextColor(Color.WHITE);
        address.setHintTextColor(Color.parseColor("#78716C"));
        address.setHint("promptly.example.com");
        String saved = Server.get(this);
        if (saved != null) address.setText(saved);
        address.setOnEditorActionListener((v, actionId, e) -> {
            save();
            return true;
        });
        box.addView(address);

        error = new TextView(this);
        error.setTextColor(Color.parseColor("#F87171"));
        error.setPadding(0, dp(8), 0, 0);
        box.addView(error);

        Button go = new Button(this);
        go.setText("Continue");
        go.setOnClickListener(v -> save());
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(16);
        box.addView(go, lp);

        setContentView(box);
    }

    private void save() {
        String origin = Server.normalise(address.getText().toString());
        if (origin == null) {
            error.setText("That doesn't look like a web address.");
            return;
        }
        done(origin);
    }

    private void done(String origin) {
        boolean firstTime = Server.get(this) == null;
        Server.set(this, origin);
        Intent next;
        if (firstTime || apps != null) {
            // New phone: pick which apps get icons, then open Promptly.
            next = new Intent(this, ChooseAppsActivity.class)
                    .putExtra(ChooseAppsActivity.EXTRA_OPEN_AFTER, true);
            if (apps != null) next.putExtra(ChooseAppsActivity.EXTRA_APPS, apps);
        } else {
            String then = getIntent().getStringExtra(EXTRA_THEN);
            next = new Intent().setClassName(this, then != null ? then : PromptlyLauncher.class.getName());
        }
        startActivity(next.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        finish();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
