"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Spinner } from "./SessionCard";
import type { PublicResource, ResourceKind } from "@/lib/resources";

type Props = { existing?: PublicResource };

export function ResourceForm({ existing }: Props) {
  const router = useRouter();
  const isEdit = Boolean(existing);

  const [kind, setKind] = useState<ResourceKind>(existing?.kind ?? "POSTGRES");
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [active, setActive] = useState(existing?.active ?? true);
  const [isDefault, setIsDefault] = useState(existing?.isDefault ?? false);

  // Postgres
  const [host, setHost] = useState("");
  const [port, setPort] = useState("5432");
  const [adminUser, setAdminUser] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminDatabase, setAdminDatabase] = useState("postgres");
  const [sslMode, setSslMode] = useState("prefer");

  // S3
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [layout, setLayout] = useState(existing?.layout ?? "PER_PROJECT_BUCKET");
  const [bucket, setBucket] = useState(existing?.bucket ?? "");
  const [forcePathStyle, setForcePathStyle] = useState(true);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    const payload: Record<string, unknown> = {
      kind,
      name: name.trim(),
      description: description.trim() || null,
      active,
      isDefault,
    };
    if (kind === "POSTGRES") {
      Object.assign(payload, {
        host: host.trim(),
        port: Number(port) || 5432,
        adminUser: adminUser.trim(),
        adminDatabase: adminDatabase.trim() || "postgres",
        sslMode,
      });
      if (adminPassword) payload.adminPassword = adminPassword;
    } else {
      Object.assign(payload, {
        endpoint: endpoint.trim(),
        region: region.trim() || "us-east-1",
        accessKey: accessKey.trim(),
        layout,
        bucket: bucket.trim() || null,
        forcePathStyle,
      });
      if (secretKey) payload.secretKey = secretKey;
    }

    try {
      const res = await fetch(isEdit ? `/api/resources/${existing?.id}` : "/api/resources", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "The resource could not be saved.");
        setSaving(false);
        return;
      }
      router.push("/resources");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  async function remove() {
    if (!existing) return;
    if (
      !window.confirm(
        `Remove "${existing.name}"? Its databases and buckets are NOT deleted — only this entry and the stored credentials.`,
      )
    ) {
      return;
    }
    setSaving(true);
    await fetch(`/api/resources/${existing.id}`, { method: "DELETE" });
    router.push("/resources");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="flex items-center gap-2">
        <Link href="/resources" className="btn btn-ghost -ml-3 px-3">
          ← Resources
        </Link>
      </div>

      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">
          {isEdit ? existing?.name : "Add resource"}
        </h1>
        <p className="mt-1 text-[14px] leading-relaxed text-[var(--text-muted)]">
          One shared instance that projects carve a namespace out of. It can live on any of your
          servers or anywhere else — this app connects to it directly.
        </p>
      </header>

      {!isEdit ? (
        <div className="grid grid-cols-2 gap-2">
          <KindButton active={kind === "POSTGRES"} onClick={() => setKind("POSTGRES")} title="Postgres" subtitle="Database per project" />
          <KindButton active={kind === "S3"} onClick={() => setKind("S3")} title="S3 storage" subtitle="Bucket per project" />
        </div>
      ) : null}

      <Field label="Name">
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "POSTGRES" ? "Main Postgres" : "Main object store"} autoComplete="off" />
      </Field>

      {kind === "POSTGRES" ? (
        <>
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <Field label="Host">
              <input className="field" value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.5" autoComplete="off" autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field label="Port">
              <input className="field" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
            </Field>
          </div>
          <Field
            label="Admin user"
            hint="Needs CREATEDB and CREATEROLE — that is what lets a project get its own database."
          >
            <input className="field" value={adminUser} onChange={(e) => setAdminUser(e.target.value)} placeholder="postgres" autoComplete="off" autoCapitalize="none" />
          </Field>
          <Field label={isEdit ? "Admin password (leave empty to keep)" : "Admin password"}>
            <input className="field" type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} autoComplete="new-password" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Admin database">
              <input className="field" value={adminDatabase} onChange={(e) => setAdminDatabase(e.target.value)} autoComplete="off" />
            </Field>
            <Field label="SSL">
              <select className="field" value={sslMode} onChange={(e) => setSslMode(e.target.value)}>
                <option value="prefer">prefer</option>
                <option value="require">require</option>
                <option value="no-verify">require, no cert check</option>
                <option value="disable">disable</option>
              </select>
            </Field>
          </div>
        </>
      ) : (
        <>
          <Field label="Endpoint" hint="For example http://10.0.0.5:9000 for MinIO.">
            <input className="field" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://s3.example.com" autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Region">
              <input className="field" value={region} onChange={(e) => setRegion(e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Layout">
              <select className="field" value={layout} onChange={(e) => setLayout(e.target.value)}>
                <option value="PER_PROJECT_BUCKET">One bucket per project</option>
                <option value="SHARED_BUCKET_PREFIX">Shared bucket, prefix per project</option>
              </select>
            </Field>
          </div>
          {layout === "SHARED_BUCKET_PREFIX" ? (
            <Field label="Shared bucket">
              <input className="field" value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="projects" autoComplete="off" />
            </Field>
          ) : null}
          <Field label="Access key">
            <input className="field font-mono text-[13px]" value={accessKey} onChange={(e) => setAccessKey(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </Field>
          <Field
            label={isEdit ? "Secret key (leave empty to keep)" : "Secret key"}
            hint="Stored encrypted. Projects receive this same key — it is not scoped per bucket."
          >
            <input className="field" type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} autoComplete="new-password" />
          </Field>
          <label className="card flex items-center gap-3 p-4">
            <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={forcePathStyle} onChange={(e) => setForcePathStyle(e.target.checked)} />
            <span className="text-[14px]">
              Path-style URLs
              <span className="block text-[12px] text-[var(--text-muted)]">
                Required by MinIO and most self-hosted stores.
              </span>
            </span>
          </label>
        </>
      )}

      <Field label="Description (optional)">
        <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Runs on Hetzner Dev 01" />
      </Field>

      <label className="card flex items-center gap-3 p-4">
        <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        <span className="text-[14px]">
          Preselect for new projects
          <span className="block text-[12px] text-[var(--text-muted)]">
            One default per kind, so New Project stays a single tap.
          </span>
        </span>
      </label>

      <label className="card flex items-center gap-3 p-4">
        <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={active} onChange={(e) => setActive(e.target.checked)} />
        <span className="text-[14px]">Active</span>
      </label>

      {error ? (
        <p className="card border-[var(--bad-fg)] p-3 text-[13px] leading-snug text-[var(--bad-fg)]">
          {error}
        </p>
      ) : null}

      <div className="sticky bottom-20 z-10 md:static">
        <button type="submit" className="btn btn-primary btn-lg w-full" disabled={saving || !name.trim()}>
          {saving ? <Spinner /> : null}
          {isEdit ? "Save changes" : "Add resource"}
        </button>
      </div>

      {isEdit ? (
        <button type="button" className="btn btn-danger w-full" onClick={() => void remove()} disabled={saving}>
          Remove resource
        </button>
      ) : null}
    </form>
  );
}

function KindButton({
  active,
  onClick,
  title,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`card p-4 text-left ${active ? "border-[var(--accent)] bg-[var(--accent-soft)]" : ""}`}
    >
      <span className="block font-semibold">{title}</span>
      <span className="block text-[12px] text-[var(--text-muted)]">{subtitle}</span>
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <span className="block text-[13px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
        {label}
      </span>
      {children}
      {hint ? <span className="block text-[12px] leading-snug text-[var(--text-muted)]">{hint}</span> : null}
    </label>
  );
}
