import { IconBrandGoogle, IconCloud, IconPlug } from "@tabler/icons-react";

// One icon per provider preset. Kept out of the "use client" dialog: a plain value exported from a client module
// reaches a server component (the Providers page) as undefined.
export const PROVIDER_ICONS = { gemini: IconBrandGoogle, cloudflare: IconCloud, custom: IconPlug } as const;
