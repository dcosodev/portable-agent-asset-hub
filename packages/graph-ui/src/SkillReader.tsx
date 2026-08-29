import { useState } from 'react';
import { MarkdownViewer } from './MarkdownViewer';
import type { ResourceMeta, SkillDetail } from './types';

export function SkillReader({ skill, resources, onOpenResource }: { skill: SkillDetail; resources: ResourceMeta[]; onOpenResource: (resource: ResourceMeta) => void }) {
  const [reading, setReading] = useState(false);
  return <section className={`skill-reader ${reading ? 'reading' : ''}`}>
    <div className="skill-reader-heading"><strong>{skill.name}</strong><small>{skill.summary ?? ''}</small><button onClick={() => setReading((value) => !value)}>{reading ? 'Close reader' : 'Read'}</button></div>
    {reading && <><nav className="skill-reader-index" aria-label="SKILL.md index">{(skill.body ?? '').split('\n').filter((line) => /^#{1,3}\s/u.test(line)).map((line) => <span key={line}>{line.replace(/^#{1,3}\s+/u, '')}</span>)}</nav><MarkdownViewer content={skill.body ?? ''} /></>}
    {!reading && resources.length > 0 && <div className="skill-reader-resources">{resources.map((resource) => <button key={resource.relativePath} onClick={() => onOpenResource(resource)}>{resource.relativePath}</button>)}</div>}
  </section>;
}
