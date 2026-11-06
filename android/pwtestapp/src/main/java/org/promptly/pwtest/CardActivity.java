package org.promptly.pwtest;

import android.app.Activity;
import android.os.Bundle;
import android.widget.LinearLayout;

/** A payment form. */
public class CardActivity extends Activity {
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout box = Ui.column(this);
        Ui.field(this, box, "cardnumber", Ui.TEXT, "creditCardNumber");
        Ui.field(this, box, "cvv", Ui.TEXT, "creditCardSecurityCode");
    }
}
