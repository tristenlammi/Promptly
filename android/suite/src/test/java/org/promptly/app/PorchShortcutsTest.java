package org.promptly.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import java.io.File;

import javax.xml.parsers.DocumentBuilderFactory;

import org.junit.Test;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

/**
 * What gen_suite.py writes for P Porch's long-press menu (WP-P2.2): New story
 * and New post, each opening the Porch launcher at that page through
 * {@link SuiteLauncher#EXTRA_URL_PATH} (a path on the saved server only).
 */
public class PorchShortcutsTest {
    private static final String ANDROID = "http://schemas.android.com/apk/res/android";

    private static File main() {
        File f = new File("src/main");
        return f.isDirectory() ? f : new File("suite/src/main");
    }

    private static Document parse(File file) throws Exception {
        DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
        f.setNamespaceAware(true);
        return f.newDocumentBuilder().parse(file);
    }

    @Test
    public void porchHasNewStoryAndNewPost() throws Exception {
        Document manifest = parse(new File(main(), "AndroidManifest.xml"));
        NodeList acts = manifest.getElementsByTagName("activity");
        String res = null;
        for (int i = 0; i < acts.getLength(); i++) {
            Element a = (Element) acts.item(i);
            if (!".PorchLauncher".equals(a.getAttributeNS(ANDROID, "name"))) continue;
            NodeList metas = a.getElementsByTagName("meta-data");
            for (int j = 0; j < metas.getLength(); j++) {
                Element m = (Element) metas.item(j);
                if ("android.app.shortcuts".equals(m.getAttributeNS(ANDROID, "name"))) res = m.getAttributeNS(ANDROID, "resource");
            }
        }
        assertEquals("@xml/shortcuts_porch", res);

        Document doc = parse(new File(main(), "res/xml/shortcuts_porch.xml"));
        NodeList shortcuts = doc.getElementsByTagName("shortcut");
        assertEquals(2, shortcuts.getLength());
        String[][] want = {{"porch_new_story", "/porch/story/new"}, {"porch_new_post", "/porch/new"}};
        for (int i = 0; i < want.length; i++) {
            Element s = (Element) shortcuts.item(i);
            assertEquals(want[i][0], s.getAttributeNS(ANDROID, "shortcutId"));
            assertEquals("@string/" + want[i][0], s.getAttributeNS(ANDROID, "shortcutShortLabel"));
            Element intent = (Element) s.getElementsByTagName("intent").item(0);
            assertNotNull(intent);
            assertEquals("org.promptly.app.PorchLauncher", intent.getAttributeNS(ANDROID, "targetClass"));
            Element extra = (Element) intent.getElementsByTagName("extra").item(0);
            assertEquals(SuiteLauncher.EXTRA_URL_PATH, extra.getAttributeNS(ANDROID, "name"));
            assertEquals(want[i][1], extra.getAttributeNS(ANDROID, "value"));
            // Only ever a path on the saved server.
            assertEquals(want[i][1], SuiteLauncher.safePath(want[i][1]));
        }

        Document strings = parse(new File(main(), "res/values/strings.xml"));
        NodeList names = strings.getElementsByTagName("string");
        int found = 0;
        for (int i = 0; i < names.getLength(); i++) {
            String n = ((Element) names.item(i)).getAttribute("name");
            if (n.equals("porch_new_story") || n.equals("porch_new_post")) found++;
        }
        assertEquals(2, found);
    }
}
