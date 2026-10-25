import type { Metadata } from "next";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { Home } from "@/components/Home";
import { homeId } from "@/content/home.id";

export const metadata: Metadata = {
  title: { absolute: homeId.title },
  description: homeId.description,
  alternates: { canonical: "/id", languages: { en: "/", id: "/id" } },
};

export default function Page() {
  return (
    <>
      <Header lang="id" otherHref="/" onHome />
      <Home lang="id" copy={homeId} />
      <Footer lang="id" />
    </>
  );
}
