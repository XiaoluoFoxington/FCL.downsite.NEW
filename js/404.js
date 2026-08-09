import { loadFeedback } from "./views/commonView.js";

document.addEventListener('DOMContentLoaded', () => {
  const feedbackContainer = document.getElementById('feedbackContainer');
  if (feedbackContainer) loadFeedback(feedbackContainer);
});