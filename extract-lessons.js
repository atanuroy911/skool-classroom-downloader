(async function extractAllLessons() {
  const allCourses = window.__NEXT_DATA__?.props?.pageProps?.allCourses || [];
  const allLessons = [];
  const groupSlug = window.location.pathname.split('/')[1];
  for (const course of allCourses) {
    const courseSlug = course.name;
    const courseTitle = course.metadata?.title || course.name;
    let moduleHtml;
    try { moduleHtml = await fetch(`/${groupSlug}/classroom/${courseSlug}`).then(r => r.text()); } catch(e) { continue; }
    const moduleMatch = moduleHtml.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!moduleMatch) continue;
    let moduleData;
    try { moduleData = JSON.parse(moduleMatch[1]); } catch(e) { continue; }
    const courseData = moduleData.props?.pageProps?.course;
    if (!courseData) continue;
    function getLessons(children) {
      let items = [];
      for (const child of (children || [])) {
        const c = child.course;
        if (c && c.unitType === 'module') {
          const m = c.metadata || {};
          items.push({ id: c.id, title: m.title || c.name || 'Untitled', slug: courseSlug, moduleTitle: courseTitle, wistiaId: m.videoId || m.wistiaId || null, externalVideoLink: m.videoLink || null, videoLenMs: m.videoLenMs || null });
        }
        if (child.children?.length) items.push(...getLessons(child.children));
      }
      return [...new Map(items.map(i => [i.id, i])).values()];
    }
    const lessons = getLessons(courseData.children || []);
    console.log(`📁 ${courseTitle}: ${lessons.length} lessons`);
    for (const lesson of lessons) {
      const lessonUrl = `/${groupSlug}/classroom/${courseSlug}?md=${lesson.id}`;
      let lessonHtml;
      try { lessonHtml = await fetch(lessonUrl).then(r => r.text()); } catch(e) { continue; }
      const lMatch = lessonHtml.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      let videoUrl = null, images = [], textContent = '';
      if (lMatch) {
        try {
          const lData = JSON.parse(lMatch[1]);
          const vid = lData.props?.pageProps?.video || {};
          const meta = lData.props?.pageProps?.course?.metadata || {};
          if (vid.playbackId && (vid.playbackToken || vid.token)) videoUrl = `https://stream.mux.com/${vid.playbackId}.m3u8?token=${vid.playbackToken || vid.token}`;
          if (!lesson.externalVideoLink && meta.videoLink) lesson.externalVideoLink = meta.videoLink;
          const imgRegex = /https:\/\/assets\.skool\.com\/[^"'\s>)\]]+\.(?:png|jpg|jpeg|gif|webp|svg)/gi;
          images = [...new Set([...lessonHtml.matchAll(imgRegex)].map(m => m[0]))].map(src => ({ src, alt: '' }));
          const bodyMatch = lessonHtml.match(/<div[^>]*class="[^"]*(?:PostTextContainer|LessonContent|EditorView|ql-editor)[^"]*"[^>]*>([\s\S]*?)<\/div>/);
          if (bodyMatch) textContent = bodyMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 5000);
        } catch(e) {}
      }
      const st = videoUrl ? '🎬' : (lesson.externalVideoLink ? '🔗' : '📄');
      console.log(`  ${st} ${lesson.title} | ${images.length} imgs`);
      allLessons.push({ title: lesson.title, moduleName: courseTitle, url: lessonUrl, durationSec: lesson.videoLenMs ? lesson.videoLenMs / 1000 : null, videoUrl: videoUrl || null, externalVideoLink: lesson.externalVideoLink || null, wistiaId: lesson.wistiaId || null, images, textContent });
      await new Promise(r => setTimeout(r, 250));
    }
  }
  const json = JSON.stringify({ lessons: allLessons }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'lesson-data-leadbase.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  console.log(`✅ DONE: ${allLessons.length} lessons — file downloaded!`);
  return allLessons.length;
})();
