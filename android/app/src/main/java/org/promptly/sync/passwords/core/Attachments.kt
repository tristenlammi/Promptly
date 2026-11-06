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

    /** Chunks are asked for in order, so one forward read of a stream serves them all. A stream
     *  that ends early, or runs on past what it said it was, is refused. */
    fun streamReader(input: java.io.InputStream, size: Long): (Long, Int) -> ByteArray {
        var at = 0L
        return { offset, length ->
            while (at < offset) {
                val skipped = input.skip(offset - at)
                if (skipped <= 0) throw java.io.IOException("That file got shorter.")
                at += skipped
            }
            val part = ByteArray(length)
            var got = 0
            while (got < length) {
                val n = input.read(part, got, length - got)
                if (n < 0) throw java.io.IOException("That file got shorter.")
                got += n
            }
            at += got
            if (at >= size && input.read() != -1) throw java.io.IOException("That file got longer.")
            part
        }
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

    /** A chunk's bound to the item it was uploaded on, so a file only moves to another item by being
     *  sealed again under it: a new id and key, one chunk at a time, and the old copy left alone. */
    fun rehome(api: VaultApi, vaultId: String, fromItem: String, toItem: String, ref: AttachmentRef, onProgress: (Int, Int) -> Unit = { _, _ -> }): AttachmentRef {
        val key = fromB64u(ref.key)
        val id = randomUuid()
        val raw = randomBytes(32)
        api.attachmentStart(vaultId, id, toItem, ref.chunks)
        for (i in 0 until ref.chunks) {
            val part = openChunk(key, vaultId, fromItem, ref.id, i, ref.chunks, api.attachmentGet(vaultId, ref.id, i))
            api.attachmentPut(vaultId, id, i, sealChunk(raw, vaultId, toItem, id, i, ref.chunks, part))
            onProgress(i + 1, ref.chunks)
        }
        api.attachmentFinish(vaultId, id)
        return ref.copy(id = id, key = b64u(raw))
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
