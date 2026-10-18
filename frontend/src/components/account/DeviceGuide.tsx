import type { ReactNode } from "react";

import { useAuthStore } from "@/store/authStore";

/**
 * How to connect each kind of device (WP-8.5): the recommended app per
 * platform, with this server's own address filled in. We don't promise
 * "map a network drive" — Windows' built-in client is deprecated and stops
 * at 50 MB.
 */
export function DeviceGuide() {
  const username = useAuthStore((s) => s.user?.username) ?? "you";
  const server = `${window.location.origin}/dav/`;
  const camera = `${server}Camera%20Uploads/`;
  const rclone = `rclone config create promptly webdav url=${server} vendor=owncloud user=${username} pass=<app password> --obscure`;

  return (
    <div className="mt-4 border-t border-[var(--border)] pt-3" aria-label="How to connect a device">
      <h3 className="mb-1 text-xs font-semibold text-[var(--text)]">How to connect</h3>
      <p className="mb-2 text-xs text-[var(--text-muted)]">
        Every app below asks for the same three things: the server <Code>{server}</Code>, your username{" "}
        <Code>{username}</Code>, and an app password made above.
      </p>
      <div className="space-y-1.5 text-xs text-[var(--text)]">
        <Platform title="iPhone or iPad — back up the camera roll">
          <p>
            Use <b>PhotoSync</b> (a paid app; an iPhone web page can't back up in the background). Add a{" "}
            <b>WebDAV</b> target with the server and app password, choose <Code>Camera Uploads</Code> as its folder, and
            turn on its year/month subfolders and auto-transfer. Photos keep their original dates, and a photo sent twice
            is kept once.
          </p>
        </Platform>
        <Platform title="Android — back up the camera roll or any folder">
          <p>
            <b>FolderSync</b>: add a WebDAV account, then a folder pair from the phone&apos;s <Code>DCIM/Camera</Code> to{" "}
            <Code>Camera Uploads</Code>, uploading one way. <b>PhotoSync</b> works too. To send a few photos now, share
            them to the installed <b>Promptly Files</b> app — they go to Camera Uploads.
          </p>
        </Platform>
        <Platform title="Mac — open your files in Finder">
          <p>
            In Finder choose <b>Go → Connect to Server</b> (⌘K), enter <Code>{server}</Code>, then your username and app
            password. Use https when connecting over the internet.
          </p>
        </Platform>
        <Platform title="Windows — a drive letter with rclone">
          <p>
            Install <b>rclone</b> and <b>WinFsp</b>, run the command below once, then{" "}
            <Code>rclone mount promptly: P: --vfs-cache-mode writes</Code>. (Windows&apos; own &quot;Map network
            drive&quot; is being retired and stops at 50 MB files.)
          </p>
          <Code block>{rclone}</Code>
        </Platform>
        <Platform title="Linux and scripts — rclone">
          <p>
            The same <Code>rclone config</Code> as for Windows, then for example{" "}
            <Code>rclone sync ~/Pictures promptly:Pictures</Code>. rclone checks each file by its hash and a second run
            sends nothing that hasn&apos;t changed.
          </p>
        </Platform>
      </div>
      <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-[var(--text-muted)]">
        <li>
          Deleting a file on a device leaves it in Promptly, so you can clear space on your phone and keep the backup.
          For a drive you open in Finder or mount with rclone, tick &quot;Deleting on this device deletes here too&quot;
          for its app password; those deletes go to Promptly&apos;s Trash, and if it deletes a lot at once you&apos;re
          told and can put it all back in one go.
        </li>
        <li>Docs, Sheets and Whiteboards show up as read-only copies; edit them in Promptly.</li>
        <li>Some types of file (such as .zip archives and programs) aren&apos;t accepted, so a sync app lists them as errors.</li>
        <li>
          Over the internet through a Cloudflare tunnel, a single file over 100 MB can&apos;t be sent this way — sync big
          folders at home, or over Tailscale. Big uploads in the browser aren&apos;t limited.
        </li>
        <li>
          Camera Uploads address for apps that want the folder in the URL: <Code>{decodeURI(camera)}</Code>
        </li>
      </ul>
    </div>
  );
}

function Platform({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="rounded-md border border-[var(--border)] px-3 py-2 [&_p]:text-[var(--text-muted)]">
      <summary className="cursor-pointer font-medium">{title}</summary>
      <div className="mt-1.5 space-y-1.5">{children}</div>
    </details>
  );
}

function Code({ children, block }: { children: ReactNode; block?: boolean }) {
  return block ? (
    <code className="block overflow-x-auto whitespace-pre rounded bg-[var(--bg)] px-2 py-1 font-mono text-[11px] text-[var(--text)]">
      {children}
    </code>
  ) : (
    <code className="rounded bg-[var(--bg)] px-1 py-0.5 font-mono text-[11px] text-[var(--text)]">{children}</code>
  );
}
