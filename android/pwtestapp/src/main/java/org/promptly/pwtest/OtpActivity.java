package org.promptly.pwtest;

import android.app.Activity;
import android.os.Bundle;
import android.widget.LinearLayout;

/** A 2FA screen. */
public class OtpActivity extends Activity {
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout box = Ui.column(this);
        Ui.field(this, box, "otp", Ui.TEXT, "one-time-code");
    }
}
