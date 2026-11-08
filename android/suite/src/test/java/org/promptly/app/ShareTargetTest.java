package org.promptly.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import javax.xml.parsers.DocumentBuilderFactory;

import org.junit.Test;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

/**
 * What gen_suite.py writes for P Porch (WP-P1.7): a launcher that's in the
 * Android share sheet (SEND / SEND_MULTIPLE for photos, videos and text, with
 * METADATA_SHARE_TARGET), and the share target's action made absolute against
 * the saved server at launch.
 */
public class ShareTargetTest {
    private static final String ANDROID = "http://schemas.android.com/apk/res/android";

    private static File main() {
        // Unit tests run in the module's folder (android/suite).
        File f = new File("src/main");
        return f.isDirectory() ? f : new File("suite/src/main");
    }

    private static Element activity(Document doc, String name) {
        NodeList list = doc.getElementsByTagName("activity");
        for (int i = 0; i < list.getLength(); i++) {
            Element e = (Element) list.item(i);
            if (name.equals(e.getAttributeNS(ANDROID, "name"))) return e;
        }
        return null;
    }

    @Test
    public void porchIsALauncherAndAShareTarget() throws Exception {
        DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
        f.setNamespaceAware(true);
        Document doc = f.newDocumentBuilder().parse(new File(main(), "AndroidManifest.xml"));
        Element porch = activity(doc, ".PorchLauncher");
        assertNotNull("P Porch launcher in the manifest", porch);
        assertEquals("P Porch", porch.getAttributeNS(ANDROID, "label"));
        assertEquals("false", porch.getAttributeNS(ANDROID, "enabled")); // the picker turns it on

        String share = null;
        String path = null;
        NodeList metas = porch.getElementsByTagName("meta-data");
        for (int i = 0; i < metas.getLength(); i++) {
            Element m = (Element) metas.item(i);
            String n = m.getAttributeNS(ANDROID, "name");
            if ("android.support.customtabs.trusted.METADATA_SHARE_TARGET".equals(n)) share = m.getAttributeNS(ANDROID, "resource");
            if ("org.promptly.app.PATH".equals(n)) path = m.getAttributeNS(ANDROID, "value");
        }
        assertEquals("/porch/", path);
        // A resource id (the library reads it with getInt), not a value.
        assertEquals("@string/share_target_porch", share);

        boolean send = false, multiple = false, images = false, videos = false, text = false;
        NodeList filters = porch.getElementsByTagName("intent-filter");
        for (int i = 0; i < filters.getLength(); i++) {
            Element fl = (Element) filters.item(i);
            NodeList actions = fl.getElementsByTagName("action");
            for (int j = 0; j < actions.getLength(); j++) {
                String a = ((Element) actions.item(j)).getAttributeNS(ANDROID, "name");
                send |= "android.intent.action.SEND".equals(a);
                multiple |= "android.intent.action.SEND_MULTIPLE".equals(a);
            }
            NodeList data = fl.getElementsByTagName("data");
            for (int j = 0; j < data.getLength(); j++) {
                String t = ((Element) data.item(j)).getAttributeNS(ANDROID, "mimeType");
                images |= "image/*".equals(t);
                videos |= "video/*".equals(t);
                text |= "text/plain".equals(t);
            }
        }
        assertTrue(send && multiple && images && videos && text);

        // Only Porch takes shares.
        Element rooms = activity(doc, ".RoomsLauncher");
        assertNotNull(rooms);
        assertEquals(1, rooms.getElementsByTagName("intent-filter").getLength());
    }

    @Test
    public void theShareTargetPostsPhotosAndWordsToPorch() throws Exception {
        String xml = new String(Files.readAllBytes(new File(main(), "res/values/share_targets.xml").toPath()), StandardCharsets.UTF_8);
        assertTrue(xml.contains("name=\"share_target_porch\""));
        // Quotes escaped for the resource compiler; read back as Android would.
        String json = xml.replaceAll("(?s).*<string name=\"share_target_porch\"[^>]*>(.*?)</string>.*", "$1").replace("\\\"", "\"");
        assertTrue(json, json.contains("\"action\": \"/porch/share-target\""));
        assertTrue(json.contains("\"method\": \"POST\""));
        assertTrue(json.contains("\"enctype\": \"multipart/form-data\""));
        // The field the service worker reads (sw.ts: form.getAll("media")).
        assertTrue(json.contains("\"name\": \"media\""));
        assertTrue(json.contains("\"image/*\"") && json.contains("\"video/*\""));
    }

    @Test
    public void theActionGetsTheSavedServerInFront() {
        String json = "{\"action\": \"/porch/share-target\", \"method\": \"POST\"}";
        assertEquals(
                "{\"action\": \"https://home.example/porch/share-target\", \"method\": \"POST\"}",
                SuiteLauncher.withServer(json, "https://home.example"));
        assertEquals(
                "{\"action\": \"https://home.example:8443/porch/share-target\", \"method\": \"POST\"}",
                SuiteLauncher.withServer(json, "https://home.example:8443/"));
        // Already absolute, protocol-relative, or nothing to do: left alone.
        String abs = "{\"action\": \"https://other.example/x\"}";
        assertEquals(abs, SuiteLauncher.withServer(abs, "https://home.example"));
        String pr = "{\"action\": \"//evil.example/x\"}";
        assertEquals(pr, SuiteLauncher.withServer(pr, "https://home.example"));
        assertNull(SuiteLauncher.withServer(null, "https://home.example"));
        assertEquals(json, SuiteLauncher.withServer(json, null));
        // A $ or \ in a server address doesn't break the replacement.
        assertTrue(SuiteLauncher.withServer(json, "https://a$b.example").contains("https://a$b.example/porch/"));
    }
}
