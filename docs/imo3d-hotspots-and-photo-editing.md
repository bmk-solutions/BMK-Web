# Hotspots and photo editing

Available in every tour under **الهوت سبوت** and **تحرير الصور AI**.

## Content points

Choose a photograph, select a content type, then click its location in the panorama. Dragging changes the view. Save the point to publish it with the tour. Points can be edited, hidden or deleted independently.

Supported content: text, image, video, audio, another panorama, external link, another tour, a destination scene, a video screen, an alternative image, a product card and a rectangular area label. Marker colour, size and stem length are editable. Files upload directly to the tour's private Supabase storage: images up to 10 MB; MP4, MP3 and WAV up to 50 MB. Links require HTTPS.

Video screens are anchored overlays. They are not Realsee's reconstructed 3D video fusion. Alternative images display supplied staging imagery; they do not automatically reconstruct or furnish a 3D model. Area labels are angular rectangles, not arbitrary mesh polygons. Existing measurement tools remain separate.

## AI photo editing

Select the object and region size, describe the change, or use the tripod shortcut. A queue stored with the tour is processed by the existing device's ChatGPT/Codex worker. The device must be online and its signed-in subscription available; Vercel serves the application and Supabase stores the jobs and results.

The worker extracts a perspective crop, calls actual image generation, and composites only the selected circular region back into a same-size 2:1 panorama. No synthetic geometry or replacement measurements are created. Images outside the selected region remain unchanged in the lossless display result; reconstructed pixels inside it require visual review.

The result is a private draft. **عرض مكان التعديل** centres the edited region; **مقارنة مع الأصل** switches the preview. **اعتماد المسودة في الجولة** changes the rendered image. **استعادة الصورة الأصلية** restores the original. Source assets and reconstruction inputs are retained. Unapproved draft assets are unavailable to public visitors; approved edits replace public image references.

Cancellation, stale source checks, revision conflicts, job heartbeats, bounded execution and stale-job recovery prevent a worker from overwriting newer edits. New asset IDs avoid stale cached image replacements. The worker locates the current installed Codex binary after desktop updates.

## Reference review and validation

Reviewed the user's authenticated Realsee Aved Compound editor: text/graphic label forms, marker styling, current-point placement, video fusion and camera removal. Reference drafts were cancelled; no reference project changes were saved.

Validated hotspot creation, repositioning, viewing and deletion with a temporary in-memory browser fixture at desktop and mobile widths. Automated tests cover URL safety, tour boundaries, scene deletion cleanup, edit lifecycle, panorama seams/poles, original preservation and private draft authorization. A real camera-tripod removal was generated and stored as an unapproved draft on the first Hamra image; no source scene was replaced during verification.
