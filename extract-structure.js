/**
 * Skool Classroom Content Extractor - Injected Script
 * 
 * This script runs inside the active browser tab on skool.com.
 * It extracts all module/lesson data from __NEXT_DATA__ and page structure.
 * 
 * Usage: Paste into browser console on https://www.skool.com/adcreatorslab/classroom
 */

(async function extractClassroomStructure() {
  'use strict';
  
  const results = { modules: [], totalLessons: 0 };
  
  // Get all courses from Next.js data
  const allCourses = window.__NEXT_DATA__?.props?.pageProps?.allCourses || [];
  console.log(`Found ${allCourses.length} modules in __NEXT_DATA__`);
  
  for (const course of allCourses) {
    const courseSlug = course.name;
    const courseTitle = course.metadata?.title || course.name;
    
    const moduleObj = {
      title: courseTitle,
      slug: courseSlug,
      url: `/adcreatorslab/classroom/${courseSlug}`,
      description: course.metadata?.desc || '',
      lessons: []
    };
    
    // Fetch the module page to get all lessons
    try {
      const res = await fetch(`/adcreatorslab/classroom/${courseSlug}`, {
        headers: { 'Accept': 'text/html,*/*', 'X-Requested-With': '' }
      });
      const html = await res.text();
      
      // Extract __NEXT_DATA__ from the HTML
      const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (match) {
        const data = JSON.parse(match[1]);
        const course_data = data.props?.pageProps?.course;
        
        if (course_data) {
          // Recursively extract all lessons/modules
          function extractItems(children, level = 0) {
            if (!children || !Array.isArray(children)) return [];
            const items = [];
            
            for (const child of children) {
              const c = child.course;
              if (!c) continue;
              
              if (c.unitType === 'module') {
                // This is a lesson
                const meta = c.metadata || {};
                const hasVideo = !!(meta.videoLink || meta.videoId || meta.wistiaId || 
                                    meta.videoLenMs || meta.videoThumbnail);
                items.push({
                  title: meta.title || c.name || 'Untitled',
                  id: c.id,
                  lessonSlug: c.name,
                  url: `/adcreatorslab/classroom/${courseSlug}?md=${c.id}`,
                  hasVideo,
                  wistiaId: meta.videoId || meta.wistiaId || null,
                  videoLink: meta.videoLink || null,
                  videoLenMs: meta.videoLenMs || null,
                  description: meta.desc || '',
                });
              } else if (c.unitType === 'chapter' || c.unitType === 'section') {
                // This is a section/chapter with sub-lessons
                const subLessons = extractItems(child.children || [], level + 1);
                items.push(...subLessons);
              }
              
              // Also recurse into nested children
              if (child.children && child.children.length > 0) {
                const nested = extractItems(child.children, level + 1);
                // Avoid duplicates
                for (const n of nested) {
                  if (!items.find(i => i.id === n.id)) {
                    items.push(n);
                  }
                }
              }
            }
            return items;
          }
          
          const children = course_data.children || [];
          moduleObj.lessons = extractItems(children);
        }
      }
    } catch (e) {
      console.error(`Error fetching ${courseSlug}:`, e.message);
      moduleObj.error = e.message;
    }
    
    results.modules.push(moduleObj);
    results.totalLessons += moduleObj.lessons.length;
    console.log(`✅ ${courseTitle}: ${moduleObj.lessons.length} lessons`);
  }
  
  console.log(`\n📊 TOTAL: ${results.modules.length} modules, ${results.totalLessons} lessons`);
  
  // Output as JSON string (copy to clipboard)
  const jsonStr = JSON.stringify(results, null, 2);
  
  // Try to copy to clipboard
  try {
    await navigator.clipboard.writeText(jsonStr);
    console.log('✅ Classroom structure copied to clipboard!');
  } catch {
    console.log('Could not copy to clipboard. Check console output below:');
  }
  
  // Also store on window for easy access
  window.__SKOOL_STRUCTURE__ = results;
  console.log('\n💡 Access the data with: window.__SKOOL_STRUCTURE__');
  console.log('💡 Or: copy(JSON.stringify(window.__SKOOL_STRUCTURE__, null, 2))');
  
  return results;
})();
