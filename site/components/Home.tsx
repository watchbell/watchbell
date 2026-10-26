import Link from "next/link";
import type { BoardRow, HomeCopy, StepKind } from "@/content/types";
import { docsPath, type Lang } from "@/lib/paths";
import { releaseVersion } from "@/lib/version";
import { BellMark } from "./BellMark";
import { CopyButton } from "./CopyButton";

// The home page: mockup/site-home.html (owner-approved, plan 7) as components. Same sections, same order, same classes.

const INSTALL = "npm install -g watchbell";

function Days({ warn = [], bad = [] }: { warn?: number[]; bad?: number[] }) {
  return (
    <div className="days">
      {Array.from({ length: 90 }, (_, i) => (
        <i key={i} className={bad.includes(i) ? "e" : warn.includes(i) ? "w" : undefined} />
      ))}
    </div>
  );
}

function Row({ row }: { row: BoardRow }) {
  return (
    <tr>
      <td className="name">
        <b>{row.name}</b>
        <small>{row.host}</small>
      </td>
      <td>
        <span className={`st ${row.kind}`}>{row.state}</span>
      </td>
      <td className="num hide-sm">{row.detail}</td>
      <td className="hide-sm">
        <Days warn={row.warn} bad={row.bad} />
      </td>
    </tr>
  );
}

function Step({ when, kind = "plain", last, title, text, children }: {
  when: string;
  kind?: StepKind;
  last?: boolean;
  title: string;
  text: string;
  children?: React.ReactNode;
}) {
  const cls = ["what", kind === "plain" ? "" : kind, last ? "last" : ""].filter(Boolean).join(" ");
  return (
    <>
      <div className="when">{when}</div>
      <div className={cls}>
        <h3>{title}</h3>
        <p>{text}</p>
        {children}
      </div>
    </>
  );
}

export function Home({ lang, copy: c }: { lang: Lang; copy: HomeCopy }) {
  // Read from the changelog at build time, so the terminal sample shows the current release.
  const version = releaseVersion();
  return (
    <main className="home" id="main">
      {/* 1. hero */}
      <section className="hero">
        <div className="wrap">
          <div>
            <span className="clock">{c.hero.clock}</span>
            <h1>
              {c.hero.title} <span>{c.hero.titleSoft}</span>
            </h1>
            <p className="lede">{c.hero.lede}</p>
            <div className="ctas">
              <a className="btn primary" href="#setup">
                {c.hero.setup}
              </a>
              <Link className="btn secondary" href={docsPath(lang)}>
                {c.hero.docs}
              </Link>
              <span className="note">{c.hero.note}</span>
            </div>
          </div>

          <div className="phone" role="figure" aria-label={c.phone.label}>
            <div className="screen">
              <div className="status">
                <span>03:13</span>
                <span>▮▮▮ 42%</span>
              </div>
              <div className="chathead">
                <span className="av"><BellMark size={34} /></span>
                <div>
                  <b>Watchbell</b>
                  <small>{c.phone.bot}</small>
                </div>
              </div>
              <div className="thread">
                <div className="b">
                  {c.phone.first}
                  <span className="t">03:12</span>
                </div>
                <div className="kb">
                  <span className="tap">{c.phone.approve}</span>
                  <span>{c.phone.reject}</span>
                </div>
                <div className="b">
                  {c.phone.sure}
                  <span className="t">03:13</span>
                </div>
                <div className="kb">
                  <span className="tap">{c.phone.yes}</span>
                  <span>{c.phone.cancel}</span>
                </div>
                <div className="b me">
                  {c.phone.yes}
                  <span className="t">03:13</span>
                </div>
                <div className="b">
                  {c.phone.back}
                  <span className="t">03:14</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 2. the night */}
      <section className="night" id="night">
        <div className="wrap">
          <span className="eyebrow">{c.night.eyebrow}</span>
          <h2>{c.night.title}</h2>
          <p className="sub">{c.night.sub}</p>

          <div className="tl">
            <Step when="02:58" {...c.night.pushed} />
            <Step when="03:12" kind="bad" {...c.night.down}>
              <div className="art log">
                <span className="h">03:10:00</span> GET orbit-blog.example <span className="o">200</span> 212 ms
                <br />
                <span className="h">03:11:00</span> GET orbit-blog.example <span className="e">timeout</span> 5 s
                <br />
                <span className="h">03:12:00</span> GET orbit-blog.example <span className="e">timeout</span> 5 s
                <br />
                <span className="h">03:12:00</span> alert: <span className="e">orbit-blog down</span> · proposed fix: roll back
              </div>
            </Step>
            <Step when="03:13" kind="you" {...c.night.asked} />
            <Step when="03:14" kind="good" title={c.night.fixed.title} text={c.night.fixed.text}>
              <div className="art mini">
                <span className="k">{c.night.fixed.response}</span>
                <span>184 ms</span>
                <span className="k">{c.night.fixed.downFor}</span>
                <span>{c.night.fixed.downForValue}</span>
                <span className="k">{c.night.fixed.action}</span>
                <span>{c.night.fixed.actionValue}</span>
              </div>
            </Step>
            <Step when="07:00" title={c.night.morning.title} text={c.night.morning.text}>
              <div className="art mail">
                <div className="mh">{c.night.morning.head}</div>
                <div className="mb">
                  {c.night.morning.summary}
                  <ul>
                    {c.night.morning.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </Step>
            <Step when="09:30" last {...c.night.desk} />
          </div>
        </div>
      </section>

      {/* 3. the board */}
      <section className="board-sec" id="board">
        <div className="wrap">
          <h2>{c.board.title}</h2>
          <p className="sub">{c.board.sub}</p>

          <div className="board">
            <div className="top">
              <b>{c.board.status}</b>
              <span className="live">{c.board.checked}</span>
              <span>{c.board.date}</span>
            </div>
            <table className="btable" aria-label={c.board.label}>
              <thead>
                <tr>
                  <th>{c.board.cols[0]}</th>
                  <th>{c.board.cols[1]}</th>
                  <th className="hide-sm">{c.board.cols[2]}</th>
                  <th className="hide-sm">{c.board.cols[3]}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="grp">
                  <td colSpan={4}>{c.board.groups.apps}</td>
                </tr>
                {c.board.apps.map((row) => (
                  <Row key={row.name} row={row} />
                ))}
                <tr className="grp">
                  <td colSpan={4}>{c.board.groups.databases}</td>
                </tr>
                {c.board.databases.map((row) => (
                  <Row key={row.name} row={row} />
                ))}
                <tr className="grp">
                  <td colSpan={4}>{c.board.groups.domains}</td>
                </tr>
                {c.board.domains.map((row) => (
                  <Row key={row.name} row={row} />
                ))}
              </tbody>
            </table>
            <div className="foot">
              <span>{c.board.footLeft}</span>
              <span>{c.board.footRight}</span>
            </div>
          </div>

          <p className="providers">{c.board.providers}</p>
        </div>
      </section>

      {/* 4. also */}
      <section className="also">
        <div className="wrap">
          <h2>{c.also.title}</h2>
          <dl>
            {c.also.items.map((item) => (
              <div className="item" key={item.term}>
                <dt>{item.term}</dt>
                <dd>
                  {item.text}
                  {item.meter ? (
                    <div className="meter">
                      <i />
                    </div>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* 5. setup */}
      <section className="setup" id="setup">
        <div className="wrap">
          <div>
            <h2>{c.setup.title}</h2>
            <ol>
              {c.setup.steps.map((step, i) => (
                <li key={i}>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <div className="copyrow">
              <CopyButton text={INSTALL} label={c.setup.copy} done={c.setup.copied} />
              <Link className="copy" href={docsPath(lang, "install", "linux")}>
                {c.setup.installers}
              </Link>
            </div>
          </div>
          <div className="term" role="figure" aria-label={c.setup.terminal}>
            <div className="tb">
              <span>~</span>
              <span>bash</span>
            </div>
            <pre>
              <span className="p">$</span> npm install -g watchbell{"\n"}
              <span className="d">added 1 package in 4s</span>
              {"\n"}
              <span className="p">$</span> watchbell{"\n"}
              Watchbell {version}
              {"\n"}
              Created ~/.watchbell/.env with new secrets <span className="d">(they are not shown)</span>.{"\n"}
              Starting on <span className="h">http://localhost:3100</span> ...{"\n"}
              Watchbell setup code: <span className="c">7HQ2M-XK4PA</span> <span className="d">(valid 24 h)</span>
              {"\n"}
              Watchbell scheduler started <span className="d">(collector every 60 s, daily at 03:00)</span>
              {"\n"}
              {"\n"}
              Watchbell is running at <span className="h">http://localhost:3100</span>
              {"\n"}
              <span className="p">$</span> watchbell service install --yes{"\n"}
              <span className="d">Watchbell will start when you log in.</span>
            </pre>
          </div>
        </div>
      </section>

      {/* 6. fine print */}
      <section className="fine">
        <div className="wrap">
          <div>
            <table className="spec">
              <tbody>
                {c.fine.rows.map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <span className="eyebrow">{c.fine.questions}</span>
            {c.fine.faq.map((item, i) => (
              <details key={item.q} open={i === 0}>
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
