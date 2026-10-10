import { useEffect, useState } from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";

const MODE_LABELS = { layer: "Layered look", default: "Styled look" };

export function ModeledCarousel({ images, label, className = "", imageClassName = "", imageProps = {}, onImageViewed, onActiveImageChange }) {
  const [index, setIndex] = useState(0);
  const imageKey = images.map((entry) => `${entry.id}:${entry.mode}`).join("|");
  useEffect(() => setIndex(0), [imageKey]);
  const activeIndex = Math.min(index, images.length - 1);
  const active = images[activeIndex];
  useEffect(() => {
    if (active) onActiveImageChange?.({ id: active.id, mode: active.mode, image: active.image });
  }, [active?.id, active?.mode, active?.image, onActiveImageChange]);
  if (!active) return null;

  const multiple = images.length > 1;
  const move = (direction) => setIndex((current) => (current + direction + images.length) % images.length);

  return (
    <div
      className={`modeled-carousel ${className}`}
      role="region"
      aria-roledescription={multiple ? "carousel" : undefined}
      aria-label={`${label} modeled photos`}
      tabIndex={multiple ? 0 : undefined}
      onKeyDown={(event) => {
        if (!multiple || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          event.stopPropagation();
          move(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <OptimizedImage
        {...imageProps}
        className={`modeled-carousel__image ${imageClassName}`}
        src={active.image}
        alt={`${label}: ${MODE_LABELS[active.mode] || MODE_LABELS.default}`}
        onLoad={(event) => {
          imageProps.onLoad?.(event);
          if (event.currentTarget.naturalWidth > 0) onImageViewed?.(active.id, active);
        }}
      />
      {multiple && <>
        <button className="modeled-carousel__arrow modeled-carousel__arrow--previous" type="button" onClick={() => move(-1)} aria-label="Previous modeled photo"><CaretLeft size={22} weight="regular" aria-hidden="true" /></button>
        <button className="modeled-carousel__arrow modeled-carousel__arrow--next" type="button" onClick={() => move(1)} aria-label="Next modeled photo"><CaretRight size={22} weight="regular" aria-hidden="true" /></button>
        <span className="modeled-carousel__caption" aria-live="polite" aria-atomic="true">{MODE_LABELS[active.mode] || MODE_LABELS.default} <span>{activeIndex + 1} / {images.length}</span></span>
      </>}
    </div>
  );
}
