package org.promptly.pwtest;

import android.app.Activity;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.View;
import android.view.autofill.AutofillManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Plain views, found by content description. The echo lets a test read what's in a password
 *  box. Only ever throwaway test values. */
final class Ui {
    private Ui() {}

    static LinearLayout column(Activity a) {
        LinearLayout box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(40, 120, 40, 40);
        a.setContentView(box);
        return box;
    }

    static EditText field(Activity a, LinearLayout box, String name, int inputType, String... hints) {
        EditText e = new EditText(a);
        e.setContentDescription(name);
        e.setHint(name);
        e.setInputType(inputType);
        if (hints.length > 0) e.setAutofillHints(hints);
        e.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_YES);
        box.addView(e);
        TextView echo = new TextView(a);
        echo.setContentDescription(name + "-echo");
        echo.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        box.addView(echo);
        e.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int c, int af) {}
            @Override public void onTextChanged(CharSequence s, int st, int b, int c) {}
            @Override public void afterTextChanged(Editable s) { echo.setText(s.toString()); }
        });
        return e;
    }

    static Button button(Activity a, LinearLayout box, String label, View.OnClickListener l) {
        Button b = new Button(a);
        b.setText(label);
        b.setContentDescription(label);
        b.setOnClickListener(l);
        box.addView(b);
        return b;
    }

    static final int TEXT = InputType.TYPE_CLASS_TEXT;
    static final int PASSWORD = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD;

    static void commit(Activity a) {
        AutofillManager m = a.getSystemService(AutofillManager.class);
        if (m != null) m.commit();
    }
}
