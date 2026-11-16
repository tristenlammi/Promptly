package org.promptly.pwtest;

import android.app.Activity;
import android.os.Bundle;
import android.widget.LinearLayout;

/** A sign-in step as plenty of apps build it: no autofill hints, a plain text box, and only
 *  the label "Email address" to go on. */
public class PlainLabelActivity extends Activity {
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout box = Ui.column(this);
        Ui.field(this, box, "Email address", Ui.TEXT);
        Ui.button(this, box, "Next", v -> finish());
    }
}
