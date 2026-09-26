"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ResourceForm } from "@/components/ResourceForm";
import type { PublicResource } from "@/lib/resources";

export default function EditResourcePage() {
  const params = useParams<{ id: string }>();
  const [resource, setResource] = useState<PublicResource | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params?.id) return;
    void (async () => {
      const res = await fetch(`/api/resources/${params.id}`, { cache: "no-store" });
      const data = (await res.json()) as { resource?: PublicResource; error?: string };
      if (!res.ok || !data.resource) setError(data.error ?? "This resource does not exist.");
      else setResource(data.resource);
    })();
  }, [params?.id]);

  if (error) {
    return (
      <div className="card p-6 text-center">
        <p className="text-[14px] text-[var(--text-muted)]">{error}</p>
        <Link href="/resources" className="btn btn-secondary mt-4">
          Back to resources
        </Link>
      </div>
    );
  }

  if (!resource) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-7 w-1/3" />
        <div className="skeleton h-64 w-full" />
      </div>
    );
  }

  return <ResourceForm existing={resource} />;
}
