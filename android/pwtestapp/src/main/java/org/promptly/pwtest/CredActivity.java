package org.promptly.pwtest;

import android.app.Activity;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.credentials.CreateCredentialRequest;
import androidx.credentials.CreateCredentialResponse;
import androidx.credentials.CreatePasswordRequest;
import androidx.credentials.CreatePublicKeyCredentialRequest;
import androidx.credentials.CreatePublicKeyCredentialResponse;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPasswordOption;
import androidx.credentials.GetPublicKeyCredentialOption;
import androidx.credentials.PasswordCredential;
import androidx.credentials.PublicKeyCredential;
import androidx.credentials.exceptions.CreateCredentialException;
import androidx.credentials.exceptions.GetCredentialException;

import java.util.Collections;

/** Calls Credential Manager the way any app would. The result goes in a text view. The request
 *  JSON comes from the test. Pass action=createPassword, createPasskey, getPassword, getPasskey. */
public class CredActivity extends Activity {
    private TextView result;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout box = Ui.column(this);
        result = new TextView(this);
        result.setContentDescription("result");
        result.setText("waiting");
        box.addView(result);
        Ui.button(this, box, "go", v -> go());
    }

    private void go() {
        String action = getIntent().getStringExtra("action");
        String json64 = getIntent().getStringExtra("json64");
        String json = json64 == null ? null : new String(android.util.Base64.decode(json64, android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP));
        CredentialManager cm = CredentialManager.create(this);
        if ("createPassword".equals(action) || "createPasskey".equals(action)) {
            CreateCredentialRequest req = "createPassword".equals(action)
                    ? new CreatePasswordRequest(getIntent().getStringExtra("id"), getIntent().getStringExtra("pw"))
                    : new CreatePublicKeyCredentialRequest(json);
            cm.createCredentialAsync(this, req, new CancellationSignal(), getMainExecutor(), new CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException>() {
                @Override public void onResult(CreateCredentialResponse r) {
                    result.setText(r instanceof CreatePublicKeyCredentialResponse ? "created:" + ((CreatePublicKeyCredentialResponse) r).getRegistrationResponseJson() : "created-password");
                }
                @Override public void onError(CreateCredentialException e) { result.setText("error:" + e.getType()); }
            });
        } else {
            GetCredentialRequest req = new GetCredentialRequest(Collections.singletonList(
                    "getPassword".equals(action) ? new GetPasswordOption() : new GetPublicKeyCredentialOption(json)));
            cm.getCredentialAsync(this, req, new CancellationSignal(), getMainExecutor(), new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override public void onResult(GetCredentialResponse r) {
                    Credential c = r.getCredential();
                    if (c instanceof PublicKeyCredential) result.setText("got:" + ((PublicKeyCredential) c).getAuthenticationResponseJson());
                    else if (c instanceof PasswordCredential) result.setText("password:" + ((PasswordCredential) c).getId() + ":" + ((PasswordCredential) c).getPassword());
                    else result.setText("other:" + c.getType());
                }
                @Override public void onError(GetCredentialException e) { result.setText("error:" + e.getType()); }
            });
        }
    }
}
