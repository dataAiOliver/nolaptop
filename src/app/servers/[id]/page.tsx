"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ServerForm } from "@/components/ServerForm";
import type { PublicServer } from "@/lib/servers";

export default function EditServerPage() {
  const params = useParams<{ id: string }>();
  const [server, setServer] = useState<PublicServer | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params?.id) return;
    void (async () => {
      const res = await fetch(`/api/servers/${params.id}`, { cache: "no-store" });
      const data = (await res.json()) as { server?: PublicServer; error?: string };
      if (!res.ok || !data.server) setError(data.error ?? "This server does not exist.");
      else setServer(data.server);
    })();
  }, [params?.id]);

  if (error) {
    return (
      <div className="card p-6 text-center">
        <p className="text-[14px] text-[var(--text-muted)]">{error}</p>
        <Link href="/servers" className="btn btn-secondary mt-4">
          Back to servers
        </Link>
      </div>
    );
  }

  if (!server) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-7 w-1/3" />
        <div className="skeleton h-64 w-full" />
      </div>
    );
  }

  return <ServerForm existing={server} />;
}
