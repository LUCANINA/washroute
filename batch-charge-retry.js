// ============================================================
// BATCH CHARGE RETRY — Group C customers (have cards on file)
// Run this from the browser console while on the admin dashboard
// charge-order v30 must be deployed first (already done)
// ============================================================

(async () => {
  const orders = [
    { id: "4833c106-bfb6-41ed-8fed-60dbb7b74978", name: "Ruth MacNaughton", amount: "$143.95" },
    { id: "0e23f070-c1b8-4ad5-800b-9a25bf43e454", name: "Brooke Rosenberg", amount: "$127.95" },
    { id: "95059a5b-f718-4043-9626-bad8d92bf479", name: "Leif Martinson", amount: "$127.95" },
    { id: "efdadd55-e72d-485c-9347-8ada52343b39", name: "Andrea Dooley", amount: "$117.95" },
    { id: "9b404914-c864-4a40-b33c-693e598d6e8a", name: "Sonny Grewal", amount: "$113.95" },
    { id: "ba3f6549-8735-44a6-a3e8-935e7b4c8c92", name: "Michelle Franzoia", amount: "$113.95" },
    { id: "a47fea95-94f3-4ca2-ac31-f1e1e51699eb", name: "Christina Spring", amount: "$107.95" },
    { id: "99b4d136-5d99-4105-adda-d3162ea35610", name: "Parker Thomas", amount: "$107.95" },
    { id: "3d23a59c-03d3-4ee9-8cd2-225578966abd", name: "DJ Rich", amount: "$104.95" },
    { id: "005b814b-3ea1-4b49-af4a-beab4bb5150d", name: "Sarah Berk", amount: "$89.95" },
    { id: "a82f9fc1-dc38-4594-b3c4-19194f0dccc4", name: "Jacqueline McEvoy", amount: "$89.95" },
    { id: "42819145-53a8-4d4f-96c2-1ef2ee0b7142", name: "Adarsh Pandit", amount: "$75.95" },
    { id: "90d1a598-3a3d-4b18-ab29-10b4b32f7964", name: "Anais Wilson", amount: "$71.95" },
    { id: "75831dd9-7baf-4402-9423-4c1fdf639594", name: "Nit Pixies #1179", amount: "$68.95" },
    { id: "c6d244fd-0857-499e-9ed7-f03e9b8ff9f1", name: "James Petrie", amount: "$68.95" },
    { id: "c6bbb558-7fe2-4520-8986-95a00a923b7a", name: "Gina Ecolino", amount: "$68.95" },
    { id: "f62fe60d-a94e-40a2-8635-fa07f5b7e78f", name: "Clarissa Lyons", amount: "$57.95" },
    { id: "1710145d-e23f-478a-8944-8e11e50a27fa", name: "Cynthia Williams", amount: "$54.95" },
    { id: "61e1d966-a851-46fc-88f5-ff083e488a6d", name: "Laurie Yalcintuna", amount: "$51.95" },
    { id: "83acb794-289b-4f11-aaec-d23f47be86ad", name: "Allison Rose", amount: "$51.95" },
    { id: "72a0d4e7-4350-42b1-ba4e-bc696af65c5c", name: "Adam Reilly", amount: "$51.95" },
    { id: "f7ae1532-116f-4de3-8dc2-99357910fb7c", name: "Micha Mokrani", amount: "$48.95" },
    { id: "0ecb1c13-238b-4c75-b45e-803e50705c1d", name: "Nit Pixies #730", amount: "$48.95" },
    { id: "0f451350-a110-48d4-9ffd-c5c9b8d04518", name: "Rebecca Lizarraga", amount: "$48.95" },
    { id: "12cf9c92-3e28-45d8-ad57-104ac0459783", name: "Paula Spiese", amount: "$48.95" },
    { id: "471014a2-e414-4ce0-ba77-dd9011bb4bf6", name: "Marjorie Westbrook", amount: "$48.95" },
    { id: "4ee8c7c8-1268-4b7c-ab50-37ba5e805842", name: "Sophia Schwartz", amount: "$48.95" },
    { id: "5bbb2ca4-8fa2-4ecf-8e27-de24ddc88957", name: "Ellen Snook", amount: "$48.95" },
    { id: "5c3f0a7f-e20f-49d6-a1d1-0e69ddcddc6d", name: "Rosalie Odean", amount: "$48.95" },
    { id: "5d75ed91-5fbf-4754-ba6a-2283029a162c", name: "Saied Amiry", amount: "$48.95" },
    { id: "7f66a2b2-4216-4cf7-b57b-0d48db4dea7a", name: "Evan Smith", amount: "$48.95" },
    { id: "859fcc00-0717-48cb-8497-177b43410b4a", name: "DongNghi Huynh", amount: "$48.95" },
    { id: "a65f921f-4336-478f-9609-39e3fb55d855", name: "Maxime Pouvreau", amount: "$48.95" },
  ];

  const results = { success: [], failed: [] };
  console.log(`Starting batch retry for ${orders.length} orders...`);

  for (const order of orders) {
    try {
      const res = await fetch(`${SUPA_URL}/functions/v1/charge-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPA_ANON_KEY },
        body: JSON.stringify({ orderId: order.id }),
      });
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (res.ok && data.success) {
        console.log(`✓ ${order.name} ${order.amount} — charged to ${data.card}`);
        results.success.push({ ...order, card: data.card });
      } else {
        console.warn(`✗ ${order.name} ${order.amount} — ${data.error}`);
        results.failed.push({ ...order, error: data.error });
      }
    } catch (e) {
      console.error(`✗ ${order.name} ${order.amount} — ${e.message}`);
      results.failed.push({ ...order, error: e.message });
    }
    await new Promise(r => setTimeout(r, 800));
  }

  console.log(`\n=== DONE ===`);
  console.log(`Charged successfully: ${results.success.length} / ${orders.length}`);
  console.log(`Failed: ${results.failed.length}`);
  if (results.failed.length) {
    console.log('\nFailed orders:');
    results.failed.forEach(f => console.log(`  ${f.name} ${f.amount}: ${f.error}`));
  }
  return results;
})();
