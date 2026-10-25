import { DocsView, docMetadata } from "@/components/DocsView";
import { docSlugs } from "@/lib/docs";

// One page per docs/*.md (README.md is /docs). Only these exist in the static export.
export const dynamicParams = false;

export function generateStaticParams() {
  return docSlugs("en").map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return docMetadata("en", slug);
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <DocsView lang="en" slug={slug} />;
}
