import { Types } from 'mongoose'
import { BoutiqueModel } from '#/modules/boutiques/boutique.model.js'

// Fixed IDs so tests can assert against them and so payloads.ts can reference
// the same phoneNumberId without importing the model.
export const TEST_BOUTIQUE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa'
export const TEST_PHONE_NUMBER_ID = 'test_phone_number_id_123'

// Seeds the single test tenant. Mirrors the shape created by seed-boutique.ts:
// Meta credentials + a fully-populated businessInfo subdocument (every field is
// `required: true` on the schema, so all must be present).
export async function createTestBoutique(): Promise<void> {
  await BoutiqueModel.create({
    _id: new Types.ObjectId(TEST_BOUTIQUE_ID),
    name: 'Test Boutique',
    phoneNumberId: TEST_PHONE_NUMBER_ID,
    wabaId: 'test_waba_id_456',
    accessToken: 'test_access_token',
    ownerPhone: '521111111111',
    status: 'active',
    globalMode: 'auto',
    businessInfo: {
      showroomAddress: 'Av. Test 123, Guadalajara',
      businessHours: 'Lunes a viernes 10am - 7pm',
      shippingPrice: 150,
      paymentMethods: 'Transferencia bancaria',
      depositPercent: 50,
      paymentDays: 3,
      deliveryInfo: '3 a 7 dias habiles una vez confirmado el pago',
    },
  })
}
