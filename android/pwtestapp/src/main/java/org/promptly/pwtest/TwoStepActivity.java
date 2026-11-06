package org.promptly.pwtest;

import android.app.Activity;
import android.os.Bundle;
import android.widget.LinearLayout;

/** Email first, then password on a new screen of the same activity, as many sign-ins do. */
public class TwoStepActivity extends Activity {
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout box = Ui.column(this);
        Ui.field(this, box, "email", Ui.TEXT, "emailAddress");
        Ui.button(this, box, "Next", v -> {
            LinearLayout second = Ui.column(this);
            Ui.field(this, second, "password", Ui.PASSWORD, "password");
            Ui.button(this, second, "Sign in", w -> {
                Ui.commit(this);
                finish();
            });
        });
    }
}
