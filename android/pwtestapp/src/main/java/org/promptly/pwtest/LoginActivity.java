package org.promptly.pwtest;

import android.app.Activity;
import android.os.Bundle;
import android.widget.LinearLayout;

/** A native sign-in form. The sign-in button commits the autofill session, which is what
 *  offers Save. */
public class LoginActivity extends Activity {
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout box = Ui.column(this);
        Ui.field(this, box, "username", Ui.TEXT, "username");
        Ui.field(this, box, "password", Ui.PASSWORD, "password");
        Ui.button(this, box, "Sign in", v -> {
            Ui.commit(this);
            finish();
        });
    }
}
