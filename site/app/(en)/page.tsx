import type { Metadata } from "next";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { Home } from "@/components/Home";
import { homeEn } from "@/content/home.en";

export const metadata: Metadata = {
  title: { absolute: homeEn.title },
  description: homeEn.description,
  alternates: { canonical: "/", languages: { en: "/", id: "/id" } },
};

export default function Page() {
  return (
    <>
      <Header lang="en" otherHref="/id" onHome />
      <Home lang="en" copy={homeEn} />
      <Footer lang="en" />
    </>
  );
}
