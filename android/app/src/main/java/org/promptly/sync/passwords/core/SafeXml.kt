// A small XML reader for KeePass files, written for this and nothing else. It has no DOCTYPE
// or entity code at all, so an external entity, a parameter entity or a billion-laughs file has
// nothing to reach: a DOCTYPE is refused, and only XML's five named references and numeric ones
// are read. Android's own parsers and the JVM's differ on exactly these points, and a test on
// one wouldn't say anything about the other, so both run this. No recursion while parsing, and
// depth and node count have limits. Pure JVM.
package org.promptly.sync.passwords.core

internal class XmlElement(val name: String, val attributes: Map<String, String>) {
    private val content = ArrayList<Any>(2)

    internal fun add(node: Any) {
        content.add(node)
    }

    val children: List<XmlElement> get() = content.filterIsInstance<XmlElement>()

    fun child(tag: String): XmlElement? {
        for (c in content) if (c is XmlElement && c.name == tag) return c
        return null
    }

    fun childrenOf(tag: String): List<XmlElement> = content.filterIsInstance<XmlElement>().filter { it.name == tag }

    /** All the text inside, in order, as the DOM's `textContent`. Depth is limited by the parser. */
    fun textContent(): String {
        val out = StringBuilder()
        appendTextTo(out)
        return out.toString()
    }

    private fun appendTextTo(out: StringBuilder) {
        for (c in content) {
            when (c) {
                is String -> out.append(c)
                is XmlElement -> c.appendTextTo(out)
            }
        }
    }
}

internal object SafeXml {
    const val MAX_DEPTH = 256
    const val MAX_NODES = 2_000_000

    /** `KeePassFile > Root`: the first in document order, as `querySelector` finds it. */
    fun keepassRoot(root: XmlElement): XmlElement? {
        if (root.name == "KeePassFile") root.child("Root")?.let { return it }
        for (c in root.children) keepassRoot(c)?.let { return it }
        return null
    }

    private fun isSpace(c: Char) = c == ' ' || c == '\n' || c == '\t' || c == '\r'
    private fun isNameStart(c: Char) = c in 'a'..'z' || c in 'A'..'Z' || c == '_' || c == ':' || c.code >= 0x80
    private fun isNameChar(c: Char) = isNameStart(c) || c in '0'..'9' || c == '-' || c == '.'

    private fun validCodePoint(c: Int) = c == 9 || c == 10 || c == 13 || c in 0x20..0xD7FF || c in 0xE000..0xFFFD || c in 0x10000..0x10FFFF

    private fun bad(why: String): Nothing = throw IllegalArgumentException(why)

    /** One or more characters XML allows at all. A surrogate pair is fine: it came from UTF-8. */
    private fun checkChars(s: String) {
        for (c in s) {
            val code = c.code
            if (code < 0x20 && c != '\t' && c != '\n' && c != '\r') bad("XML with a control character in it")
            if (code == 0xFFFE || code == 0xFFFF) bad("XML with a character it doesn't allow")
        }
    }

    /** Only the references XML defines by itself. Any other name would need a DOCTYPE to mean anything. */
    private fun references(s: String): String {
        if (s.indexOf('&') < 0) return s
        val out = StringBuilder(s.length)
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c != '&') {
                out.append(c)
                i++
                continue
            }
            val end = s.indexOf(';', i)
            if (end < 0 || end - i > 12) bad("XML with a stray &")
            when (val name = s.substring(i + 1, end)) {
                "amp" -> out.append('&')
                "lt" -> out.append('<')
                "gt" -> out.append('>')
                "quot" -> out.append('"')
                "apos" -> out.append('\'')
                else -> {
                    if (!name.startsWith("#")) bad("XML that uses an entity of its own")
                    val code = if (name.startsWith("#x")) name.substring(2).toIntOrNull(16) else name.substring(1).toIntOrNull()
                    if (code == null || !validCodePoint(code)) bad("XML with a bad character reference")
                    out.appendCodePoint(code)
                }
            }
            i = end + 1
        }
        return out.toString()
    }

    fun parse(raw: String): XmlElement {
        // XML says line ends are read as \n, before anything else. A &#13; stays what it is.
        val s = raw.removePrefix("﻿").replace("\r\n", "\n").replace('\r', '\n')
        val open = ArrayList<XmlElement>()
        var root: XmlElement? = null
        var nodes = 0
        var i = 0

        fun readName(): String {
            val start = i
            if (i >= s.length || !isNameStart(s[i])) bad("XML with a bad name")
            while (i < s.length && isNameChar(s[i])) i++
            return s.substring(start, i)
        }

        fun skipSpace() {
            while (i < s.length && isSpace(s[i])) i++
        }

        while (i < s.length) {
            if (s[i] != '<') {
                val end = s.indexOf('<', i).let { if (it < 0) s.length else it }
                val run = s.substring(i, end)
                checkChars(run)
                if (open.isEmpty()) {
                    if (!run.all { isSpace(it) }) bad("XML with text outside its root")
                } else {
                    if (run.contains("]]>")) bad("XML with a stray ]]>")
                    open[open.size - 1].add(references(run))
                }
                i = end
                continue
            }
            if (s.startsWith("<?", i)) {
                val end = s.indexOf("?>", i + 2)
                if (end < 0) bad("XML with an unfinished instruction")
                if (s.regionMatches(i + 2, "xml", 0, 3, ignoreCase = true) && i + 5 < s.length && isSpace(s[i + 5]) && i != 0) bad("XML with a declaration in the wrong place")
                i = end + 2
            } else if (s.startsWith("<!--", i)) {
                val end = s.indexOf("--", i + 4)
                if (end < 0 || end + 2 >= s.length || s[end + 2] != '>') bad("XML with a bad comment")
                i = end + 3
            } else if (s.startsWith("<![CDATA[", i)) {
                if (open.isEmpty()) bad("XML with text outside its root")
                val end = s.indexOf("]]>", i + 9)
                if (end < 0) bad("XML with an unfinished CDATA")
                val run = s.substring(i + 9, end)
                checkChars(run)
                open[open.size - 1].add(run)
                i = end + 3
            } else if (s.startsWith("<!DOCTYPE", i)) {
                bad("XML with a DOCTYPE, which we don't accept")
            } else if (s.startsWith("<!", i)) {
                bad("XML with a declaration we don't accept")
            } else if (s.startsWith("</", i)) {
                i += 2
                val name = readName()
                skipSpace()
                if (i >= s.length || s[i] != '>') bad("XML with a bad end tag")
                i++
                if (open.isEmpty() || open[open.size - 1].name != name) bad("XML whose tags don't match")
                open.removeAt(open.size - 1)
            } else {
                i++
                if (open.isEmpty() && root != null) bad("XML with two roots")
                if (open.size >= MAX_DEPTH) bad("XML that nests too deeply")
                if (++nodes > MAX_NODES) bad("XML with too many elements")
                val name = readName()
                var attributes: LinkedHashMap<String, String>? = null
                var selfClosed = false
                while (true) {
                    val before = i
                    skipSpace()
                    if (i >= s.length) bad("XML with an unfinished tag")
                    if (s[i] == '>') {
                        i++
                        break
                    }
                    if (s[i] == '/') {
                        if (i + 1 >= s.length || s[i + 1] != '>') bad("XML with a bad tag")
                        i += 2
                        selfClosed = true
                        break
                    }
                    if (i == before) bad("XML with a bad tag")
                    val key = readName()
                    skipSpace()
                    if (i >= s.length || s[i] != '=') bad("XML with a bad attribute")
                    i++
                    skipSpace()
                    if (i >= s.length || (s[i] != '"' && s[i] != '\'')) bad("XML with a bad attribute")
                    val end = s.indexOf(s[i], i + 1)
                    if (end < 0) bad("XML with an unfinished attribute")
                    val value = s.substring(i + 1, end)
                    if (value.indexOf('<') >= 0) bad("XML with a bad attribute")
                    checkChars(value)
                    val map = attributes ?: LinkedHashMap<String, String>().also { attributes = it }
                    if (key in map) bad("XML with a repeated attribute")
                    map[key] = references(value.replace('\n', ' ').replace('\t', ' '))
                    i = end + 1
                }
                val element = XmlElement(name, attributes ?: emptyMap())
                if (open.isEmpty()) root = element else open[open.size - 1].add(element)
                if (!selfClosed) open.add(element)
            }
        }
        if (open.isNotEmpty()) bad("XML that stops part way")
        return root ?: bad("XML with nothing in it")
    }
}
