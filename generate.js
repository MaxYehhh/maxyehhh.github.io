const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

const notion = new Client({ auth: process.env.NOTION_TOKEN });

function toText(richText) {
  if (!richText || !richText.length) return '';
  return richText.map(t => t.plain_text).join('');
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sectionMatch(heading, keywords) {
  const h = heading.toLowerCase();
  return keywords.some(k => h.includes(k.toLowerCase()));
}

async function fetchBlocks(blockId) {
  const blocks = [];
  let cursor;
  do {
    const { results, has_more, next_cursor } = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    blocks.push(...results);
    cursor = has_more ? next_cursor : undefined;
  } while (cursor);
  return blocks;
}

async function generateResume(notionPageId, outputPath) {
  // Get page title
  const page = await notion.pages.retrieve({ page_id: notionPageId });
  const titleProp = Object.values(page.properties).find(p => p.type === 'title');
  const name = titleProp ? toText(titleProp.title) : '';

  // Fetch blocks
  const blocks = await fetchBlocks(notionPageId);

  const data = {
    name,
    tagline: '',
    about: [],
    education: [],
    experience: [],
    skills: [],
    contact: [],
  };

  let currentSection = '';
  let currentSkillGroup = null;
  let gotTagline = false;

  for (const block of blocks) {
    const type = block.type;

    if (type === 'heading_2') {
      const text = toText(block.heading_2.rich_text).trim();
      currentSkillGroup = null;
      if (sectionMatch(text, ['關於', 'about'])) {
        currentSection = 'about';
      } else if (sectionMatch(text, ['學歷', 'education'])) {
        currentSection = 'education';
      } else if (sectionMatch(text, ['工作', 'experience', '經歷', '專案'])) {
        currentSection = 'experience';
      } else if (sectionMatch(text, ['技能', 'skills', 'skill'])) {
        currentSection = 'skills';
      } else if (sectionMatch(text, ['聯絡', 'contact'])) {
        currentSection = 'contact';
      } else {
        currentSection = '';
      }
      continue;
    }

    if (type === 'paragraph') {
      const text = toText(block.paragraph.rich_text).trim();
      if (!text) continue;
      if (!currentSection && !gotTagline) {
        data.tagline = text;
        gotTagline = true;
      } else if (currentSection === 'about') {
        data.about.push(text);
      }
      continue;
    }

    if (type === 'bulleted_list_item') {
      const text = toText(block.bulleted_list_item.rich_text).trim();
      if (!text) continue;
      if (currentSection === 'about') {
        data.about.push(text);
      } else if (currentSection === 'education') {
        data.education.push(text);
      } else if (currentSection === 'experience') {
        data.experience.push(text);
      } else if (currentSection === 'skills') {
        currentSkillGroup = { category: text, items: [] };
        data.skills.push(currentSkillGroup);
      } else if (currentSection === 'contact') {
        data.contact.push(text);
      }
      continue;
    }
  }

  // Fetch nested children for skill groups
  for (const block of blocks) {
    if (block.type === 'bulleted_list_item' && block.has_children) {
      const parentText = toText(block.bulleted_list_item.rich_text).trim();
      const group = data.skills.find(s => s.category === parentText);
      if (group) {
        const children = await fetchBlocks(block.id);
        for (const child of children) {
          if (child.type === 'bulleted_list_item') {
            const childText = toText(child.bulleted_list_item.rich_text).trim();
            if (childText) group.items.push(childText);
          }
        }
      }
    }
  }

  // Ensure output directory exists
  const outDir = path.dirname(path.join(__dirname, outputPath));
  fs.mkdirSync(outDir, { recursive: true });

  // Build and write HTML
  const template = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf-8');
  const html = buildHtml(template, data);
  fs.writeFileSync(path.join(__dirname, outputPath), html, 'utf-8');
  console.log(`Done: ${outputPath}`);
}

function buildHtml(template, data) {
  const aboutHtml = data.about.length
    ? data.about.map(p => `<p>${esc(p)}</p>`).join('\n        ')
    : '<p></p>';

  const educationHtml = data.education
    .map(e => `<li>${esc(e)}</li>`)
    .join('\n            ');

  const experienceHtml = data.experience
    .map(e => `<li>${esc(e)}</li>`)
    .join('\n            ');

  const skillsHtml = data.skills.map(s => {
    const itemsHtml = s.items.length
      ? `<ul>\n                ${s.items.map(i => `<li>${esc(i)}</li>`).join('\n                ')}\n            </ul>`
      : '';
    return `<div class="skill-group">\n                <h3>${esc(s.category)}</h3>\n                ${itemsHtml}\n            </div>`;
  }).join('\n            ');

  const contactHtml = data.contact.map(c => {
    const cl = c.toLowerCase();
    const val = c.includes('：') ? c.split('：').slice(1).join('：').trim()
              : c.includes(':') ? c.split(':').slice(1).join(':').trim()
              : c.trim();
    let href = '';
    let emoji = '🔗';
    if (cl.includes('email') || cl.includes('信箱') || val.includes('@')) {
      href = `mailto:${val}`;
      emoji = '📧';
    } else if (cl.includes('github')) {
      href = val.startsWith('http') ? val : `https://github.com/${val}`;
      emoji = '🐙';
    } else if (cl.includes('linkedin')) {
      href = val.startsWith('http') ? val : `https://linkedin.com/in/${val}`;
      emoji = '💼';
    } else {
      href = val.startsWith('http') ? val : '#';
    }
    const external = href.startsWith('http') ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${esc(href)}"${external}>${emoji} ${esc(val)}</a>`;
  }).join('\n            ');

  return template
    .replaceAll('{{NAME}}', esc(data.name))
    .replace('{{TAGLINE}}', esc(data.tagline))
    .replace('{{ABOUT}}', aboutHtml)
    .replace('{{EDUCATION}}', educationHtml)
    .replace('{{EXPERIENCE}}', experienceHtml)
    .replace('{{SKILLS}}', skillsHtml)
    .replace('{{CONTACT}}', contactHtml);
}

async function main() {
  const resumes = JSON.parse(fs.readFileSync(path.join(__dirname, 'resumes.json'), 'utf-8'));
  for (const { notionPageId, outputPath } of resumes) {
    await generateResume(notionPageId, outputPath);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
