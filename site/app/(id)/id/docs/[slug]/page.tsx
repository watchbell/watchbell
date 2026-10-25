import { DocsView, docMetadata } from "@/components/DocsView";
import { docSlugs } from "@/lib/docs";

// One page per English page: docs/id/<slug>.md when it is there, else "Terjemahan sedang disiapkan".
export const dynamicParams = false;

export function generateStaticParams() {
  return docSlugs("id").map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return docMetadata("id", slug);
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <DocsView lang="id" slug={slug} />;
}
