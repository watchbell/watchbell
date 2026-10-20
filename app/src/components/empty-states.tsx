import { IconActivity, IconApps, IconHeartbeat, IconRocket } from "@tabler/icons-react";
import Link from "next/link";
import { buttonClass, EmptyState } from "@/components/kit";

// R7: the typed empty states the mockup doesn't draw.
export function NoApps({ owner }: { owner: boolean }) {
  return (
    <EmptyState
      icon={IconApps}
      title="No applications watched yet"
      action={owner ? <Link href="/connections" className={buttonClass({ size: "sm" })}>Open connections</Link> : undefined}
    >
      {owner ? "Connect Vercel, then press Sync and tick the apps to watch." : "An owner picks the apps to watch in Connections."}
    </EmptyState>
  );
}

export function NoDeployments() {
  return <EmptyState icon={IconRocket} title="No deployments in the last 30 days">New ones show up here after the next collector run.</EmptyState>;
}

// Only someone who can add monitors is told about the Add monitor control.
export function NoMonitors({ canAct = false }: { canAct?: boolean }) {
  return (
    <EmptyState icon={IconHeartbeat} title="No monitors yet">
      Every watched app gets one at its domain.{canAct ? " Add more with Add monitor." : ""}
    </EmptyState>
  );
}

export function NoEvents() {
  return <EmptyState icon={IconActivity} title="No events yet">Deployments, monitor changes and the daily jobs show up here.</EmptyState>;
}
