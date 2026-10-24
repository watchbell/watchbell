import {
  IconActivity, IconApi, IconApps, IconBell, IconBolt, IconBooks, IconBrandGithub, IconBroadcast, IconBrowser, IconCloud, IconCloudUpload, IconDatabase, IconFileText,
  IconFlame, IconHeartbeat, IconHierarchy3, IconLayoutDashboard, IconLayoutList, IconPlugConnected, IconRocket, IconRoute2, IconSettings, IconSitemap, IconTerminal2, IconWorld,
} from "@tabler/icons-react";
import type { NavIconKey } from "@/lib/nav";

export const NAV_ICONS: Record<NavIconKey, typeof IconApps> = {
  dashboard: IconLayoutDashboard, topology: IconHierarchy3, activity: IconActivity, apps: IconApps, rocket: IconRocket,
  world: IconWorld, sitemap: IconSitemap, bolt: IconBolt, database: IconDatabase, flame: IconFlame, books: IconBooks,
  heartbeat: IconHeartbeat, bell: IconBell, file: IconFileText, broadcast: IconBroadcast, plug: IconPlugConnected,
  "cloud-upload": IconCloudUpload, cloud: IconCloud, settings: IconSettings, route: IconRoute2, api: IconApi, github: IconBrandGithub, terminal: IconTerminal2,
  layout: IconLayoutList, page: IconBrowser,
};
