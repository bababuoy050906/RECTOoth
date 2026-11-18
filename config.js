/* RECTOoth settings. Edit this file only; you should not need to touch app.js. */
window.RECTOOTH_CONFIG = {
  // Replace this placeholder with your own Messenger link. Examples:
  //   https://m.me/your.username     (Facebook profile or page username)
  //   https://m.me/1234567890        (numeric page ID)
  messengerLink: "https://m.me/YOUR_MESSENGER_USERNAME",

  currencySymbol: "\u20B1",

  // Adds a short Filipino version to the pre-order message.
  includeFilipinoInMessage: true,

  // Shown in the "Important information" box on the pre-order form.
  preorderNotes: [
    "A pre-order only reserves the tooth. Nothing is paid on this site.",
    "Send the copied message in chat so the seller can confirm your order.",
    "Meetups happen in public places near Mendiola or Recto. The seller may suggest another place or time.",
    "A map pin is optional. It is only shared through the message and image you send in chat."
  ],

  // Map used for the optional meetup pin (Sampaloc, near Mendiola and Recto).
  map: {
    center: [14.604, 120.9925],
    zoom: 16,
    minZoom: 14,
    bounds: [[14.585, 120.965], [14.625, 121.015]]
  }
};
