/** Shimmering placeholders shown while data loads - keeps layout stable and
 *  reads as "working" rather than "broken/empty". */

export function SkeletonCards({ n = 6 }: { n?: number }) {
  return (
    <div className="grid">
      {Array.from({ length: n }).map((_, i) => (
        <div className="card skcard" key={i} style={{ animationDelay: `${i * 0.05}s` }}>
          <div className="skcard__top">
            <span className="skel skel--tag" />
            <span className="skel skel--rep" />
          </div>
          <span className="skel skel--title" />
          <span className="skel skel--agent" />
          <span className="skel skel--line" />
          <span className="skel skel--line skel--short" />
          <div className="skcard__foot">
            <span className="skel skel--price" />
            <span className="skel skel--btn" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SkeletonProfile() {
  return (
    <>
      <section className="prof">
        <span className="skel skel--avatar" />
        <div className="prof__id" style={{ flex: 1 }}>
          <span className="skel skel--name" />
          <span className="skel skel--key" />
        </div>
      </section>
      <div className="stats">
        {Array.from({ length: 6 }).map((_, i) => (
          <div className="stat" key={i}>
            <span className="skel skel--statv" />
            <span className="skel skel--statl" />
          </div>
        ))}
      </div>
    </>
  );
}
