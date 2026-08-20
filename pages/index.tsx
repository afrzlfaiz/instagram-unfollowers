import Head from "next/head";
import type { GetServerSideProps, InferGetServerSidePropsType } from "next";
import InstagramUnfollowApp from "../components/InstagramUnfollowApp";
import { analyzeAccount } from "../lib/instagram/analysis";
import { readUrlEncodedForm } from "../lib/form";
import { normalizeUsername } from "../lib/instagram/validation";
import type { AnalysisResult, TargetProfile } from "../lib/instagram/types";

interface PageProps {
  initialResult: AnalysisResult | null;
  initialProfile: TargetProfile | null;
  initialUsername: string;
  initialError: string | null;
}

export const getServerSideProps: GetServerSideProps<PageProps> = async ({ req, res }) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    return {
      props: {
        initialResult: null,
        initialProfile: null,
        initialUsername: "",
        initialError: null,
      },
    };
  }

  try {
    const form = await readUrlEncodedForm(req);
    const sessionid = (form.get("sessionid") || "").trim();
    const rawUsername = form.get("username") || "";
    const initialUsername = rawUsername.trim().replace(/^@/, "").toLowerCase();
    if (!sessionid || !rawUsername.trim()) {
      throw new Error("Session ID dan Username target wajib diisi!");
    }
    const normalizedUsername = normalizeUsername(rawUsername);
    const analysis = await analyzeAccount(sessionid, normalizedUsername);
    return {
      props: {
        initialResult: analysis.result,
        initialProfile: analysis.targetProfile,
        initialUsername: normalizedUsername,
        initialError: null,
      },
    };
  } catch (error) {
    console.error("POST / analysis failed", error instanceof Error ? error.message : error);
    return {
      props: {
        initialResult: null,
        initialProfile: null,
        initialUsername: "",
        initialError: error instanceof Error ? error.message : "Terjadi kesalahan saat mengambil data. Coba lagi.",
      },
    };
  }
};

export default function HomePage({
  initialResult,
  initialProfile,
  initialUsername,
  initialError,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <>
      <Head>
        <title>Instagram Unfollow • Followers, Following &amp; Unfollowers Checker</title>
        <meta name="description" content="Analisis followers dan following Instagram." />
      </Head>
      <InstagramUnfollowApp
        initialResult={initialResult}
        initialProfile={initialProfile}
        initialUsername={initialUsername}
        initialError={initialError}
      />
    </>
  );
}
