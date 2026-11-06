// Encrypted attachments (CRYPTO_SPEC.md section 9), same bytes as attachments.ts: 1 MiB
// chunks under a key of their own, recorded inside the item's body. Chunks read and write
// one at a time, so a large file doesn't have to fit in memory.
package org.promptly.sync.passwords.core

object Attachments {
    const val CHUNK = 1024 * 1024

    private fun chunkAad(vaultId: String, itemId: String, id: String, i: Int, total: Int) = aad(vaultId, itemId, "att:$id:$i:$total")

    fun chunksFor(size: Long): Int = maxOf(1, ((size + CHUNK - 1) / CHUNK).toInt())

    /** Every chunk's the same size on the wire, the last one padded. */
    fun sealChunk(key: ByteArray, vaultId: String, itemId: String, id: String, i: Int, total: Int, part: ByteArray): ByteArray {
        require(part.size <= CHUNK) { "chunk too large" }
        val plain = ByteArray(CHUNK + 4)
        plain[0] = (part.size ushr 24).toByte()
        plain[1] = (part.size ushr 16).toByte()
        plain[2] = (part.size ushr 8).toByte()
        plain[3] = part.size.toByte()
        part.copyInto(plain, 4)
        return seal(key, plain, chunkAad(vaultId, itemId, id, i, total))
    }

    fun openChunk(key: ByteArray, vaultId: String, itemId: String, id: String, i: Int, total: Int, blob: ByteArray): ByteArray {
        val plain = open(key, blob, chunkAad(vaultId, itemId, id, i, total))
        require(plain.size >= 4) { "That attachment is damaged" }
        val n = ((plain[0].toInt() and 255) shl 24) or ((plain[1].toInt() and 255) shl 16) or ((plain[2].toInt() and 255) shl 8) or (plain[3].toInt() and 255)
        if (n < 0 || n > plain.size - 4) throw IllegalArgumentException("That attachment is damaged")
        return plain.copyOfRange(4, 4 + n)
    }

    /** `read(offset, length)` gives that part of the file. Resumes from what the server has
     *  when `resume` names an earlier try. */
    fun upload(
        api: VaultApi,
        vaultId: String,
        itemId: String,
        name: String,
        mime: String?,
        size: Long,
        read: (Long, Int) -> ByteArray,
        onProgress: (Int, Int) -> Unit = { _, _ -> },
        resume: Pair<String, String>? = null,
    ): AttachmentRef {
        val id = resume?.first ?: randomUuid()
        val raw = resume?.let { fromB64u(it.second) } ?: randomBytes(32)
        val chunks = chunksFor(size)
        val started = api.attachmentStart(vaultId, id, itemId, chunks)
        val have = started.received.toSet()
        for (i in 0 until chunks) {
            if (i in have) continue
            val at = i.toLong() * CHUNK
            val part = read(at, minOf(size - at, CHUNK.toLong()).toInt())
            api.attachmentPut(vaultId, id, i, sealChunk(raw, vaultId, itemId, id, i, chunks, part))
            onProgress(i + 1, chunks)
        }
        api.attachmentFinish(vaultId, id)
        return AttachmentRef(id, name, size, b64u(raw), chunks, mime)
    }

    /** Hands each decrypted part to `write`, in order. Refuses a damaged or short file. */
    fun download(api: VaultApi, vaultId: String, itemId: String, ref: AttachmentRef, write: (ByteArray) -> Unit, onProgress: (Int, Int) -> Unit = { _, _ -> }) {
        val key = fromB64u(ref.key)
        var at = 0L
        for (i in 0 until ref.chunks) {
            val part = openChunk(key, vaultId, itemId, ref.id, i, ref.chunks, api.attachmentGet(vaultId, ref.id, i))
            if (at + part.size > ref.size) throw IllegalArgumentException("That attachment is damaged")
            write(part)
            at += part.size
            onProgress(i + 1, ref.chunks)
        }
        if (at != ref.size) throw IllegalArgumentException("That attachment is damaged")
    }
}
