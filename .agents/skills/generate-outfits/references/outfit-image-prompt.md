# Outfit image prompt

<!-- Keep in step with the outfit regeneration prompt in scripts/photo-feedback-api.mjs (generationPackage); update both together. -->

Use this template with the identity reference first, then the exact wardrobe cutouts in the listed order. Delete optional clauses that do not apply. Archive each exact completed prompt as described in [the shared image-history instructions](../../../../docs/image-history-for-agents.md).

```text
Use case: identity-preserve
Asset type: square outfit gallery photograph

Image 1: identity reference for the exact person to preserve.
Image 2: exact top garment reference.
Image 3: exact bottom garment reference.
[Image 4: exact outer-layer reference. Preserve its real construction and closure exactly; never invent a zipper, buttons, placket, or opening.]
[Image 5: exact shoe or accessory reference.]

Primary request: Create a professional square editorial fashion photograph of the person from Image 1 wearing all of the exact referenced garments, and only those garments.

Outfit: [OUTFIT NAME]
Wearing assignments: [List the exact garment IDs, roles and modes. Default mode is the normal presentation; layer mode places the piece over the distinct selected wardrobe inner top, using its true construction and closures.]
Scene/backdrop: [RESTRAINED REAL-WORLD SETTING].

Subject: Preserve the same person's recognizable face, hair, age, build, skin texture, and body proportions. Dress them in the exact top and bottom references[ plus the exact outer-layer reference][ and the exact selected shoes/accessory] in their recorded wearing modes. Plain understated shoes and invisible basics such as socks are allowed only where needed when no shoe reference is provided. Do not add, replace, or invent any other visible clothing or accessory.

Styling: Apply the judgment of an experienced menswear stylist. Balance the selected pieces in fit, proportion, color and texture for [OCCASION]. Use the exact selected inner piece, such as a T-shirt or hoodie where its bulk suits the outer layer, and make the layered outfit fashionable and well-balanced.

Style/medium: Photorealistic natural editorial fashion campaign with authentic skin and fabric texture and no synthetic AI polish.

Composition/framing: Square 1:1 image. Show the complete person and outfit from head through shoes. Keep the person centered and occupying most of the frame with modest breathing room. Use a relaxed, mostly front-facing pose with arms away from the torso so every item remains readable.

Lighting/mood: Warm professional natural light, realistic shadows, and restrained editorial color grading.

Garment fidelity: Preserve every referenced garment precisely: color, material, fit, construction, pattern, graphics, logos, text, proportions, distinctive details, and real closure construction. Keep the top and bottom recognizable without changing their natural length, tuck, or construction.

[Layered-look clause: Layer the exact inner top and outer layer naturally so both remain visibly identifiable. First inspect the outer reference. If it has a real full front button or zipper closure, it may be worn naturally open or partly open using only that closure. If it is a pullover or has no full front opening, keep it closed exactly as designed and reveal the inner top only at its real collar or neckline, sleeve or cuff edge, or a natural untucked hem below the outer layer. Never invent, add, split, unzip, unbutton, or simulate a closure. Keep the outer garment at its true length even when it overlaps the waistband.]

Avoid: Completely hidden selected garments, invented zippers, buttons, openings or plackets, unnatural layering, extra layers, hats, bags, scarves, jewelry, visible unreferenced undershirts, crossed arms, hands blocking clothing, garment redesign, changed logos or text, cropped feet, extra people, text overlays, watermarks, studio cutout appearance, or synthetic AI polish.
```

Use a corrective pass rather than repeating the same prompt when an output fails. Attach the failed output and exact references, name the concrete failure, preserve successful parts, and restate the relevant fidelity or layering constraint.
