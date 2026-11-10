self.addEventListener('push', function (event) {
  let data = { title: '⚠️ PORCH PIRATE ALERT ⚠️', body: 'Suspicious parcel activity reported in your complex.' };
  try {
    if (event.data) {
      const json = event.data.json();
      data.title = json.title || data.title;
      data.body = `${json.buildingName} • ${json.incidentLocation}\nSuspect: ${json.details}`;
      data.buildingId = json.buildingId;
    }
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/favicon.ico',
    data: { buildingId: data.buildingId }
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const bId = event.notification.data?.buildingId;
  const targetUrl = bId ? `https://findmypackage.tech{bId}` : 'https://findmypackage.tech';
  event.waitUntil(clients.matchAll({ type: 'window' }).then(function (list) {
    for (let client of list) { if (client.url === targetUrl && 'focus' in client) return client.focus(); }
    if (clients.openWindow) return clients.openWindow(targetUrl);
  }));
});
