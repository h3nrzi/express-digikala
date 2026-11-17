# Ecommerce Marketplace Backend

Defines shared terms for the marketplace backend so buyer and seller roles remain distinct in decisions.

## Language

**Buyer**:
An individual or organization that purchases a physical good through the marketplace. In the MVP, individual consumers are the initial target group.
_Avoid_: Customer (when it does not clearly distinguish the buyer role from the seller role)

**Seller**:
An individual or organization that offers goods for sale through the marketplace. A seller may be the platform or a third party.

**Third-Party Seller**:
An individual or legal entity outside the platform that offers goods through the marketplace.

**User Account**:
An individual's login identity in the system, separate from the buyer role and the seller entity. An individual may have a buyer profile and authorized internal roles; third-party sellers do not have login accounts in the MVP.

**User Account Status**:
The state of an individual's ability to sign in: active, temporarily locked, suspended pending an internal decision, or closed at the individual's request. Suspending or closing an account does not by itself cancel placed orders, and this status is distinct from seller participation status.

**Operational User**:
An individual who uses a personal user account and authorized roles to perform internal marketplace operations.

**Operational Role**:
A set of access permissions for an area of internal marketplace operations, such as seller management, catalog, orders and support, finance, or access management. An operational user may have multiple roles.

**Access Administrator**:
An operational user authorized to invite users and grant or revoke roles. This role alone does not grant permission to perform order or financial operations.

**Sales Commission**:
The amount the platform charges a third-party seller for a marketplace sale. In the MVP, it is a percentage of the net amount for the quantity the buyer keeps; shipping costs and taxes are excluded from the calculation base.

**Seller Participation**:
A third-party seller's authorization status in the marketplace. Its lifecycle includes application, review, active, rejected, and suspended states, and is distinct from user account status.

**Product Family**:
A shared catalog definition of a physical product that includes its purchasable variants. Products that are merely similar in function are not part of the same family.

**Product Family Identity Attribute**:
A catalog attribute that helps distinguish a product family from similar products, together with the product category and, when available, the manufacturer's brand or model identifier.

**Product Variant**:
A specific, purchasable configuration of a product family, distinguished from other variants by a buying choice such as size, color, material, capacity, or quantity per package. A seller offer is linked to an exact variant.

**Variant-Defining Attribute**:
An attribute whose different value creates another purchasable option within the same product family. A difference only in imagery or packaging appearance does not by itself create a new variant.

**Shared Product Content**:
The title, description, and base and category-specific specifications for a product family and its variants, created, approved, and maintained by the internal team. A seller may suggest information or media but cannot edit this content directly.

**Seller Offer**:
A seller's offer for an exact product variant. A third-party seller is responsible for its offer data, including price and inventory; shared product data and content are managed separately. For direct sales, the platform is also a seller in this model.

**Shopping Cart**:
The seller offers and selected quantities that a buyer keeps before placing an order.

**Order Line**:
A seller offer and the quantity of it ordered in a buyer order.

**Buyer Order**:
A purchase placed by a buyer that groups its order lines into seller suborders and summarizes the overall purchase status.

**Seller Suborder**:
The part of a buyer order containing the lines from one seller, whose preparation and delivery are tracked independently. For direct sales, the platform counts as a seller.

**Physical Inventory**:
The number of units of a seller offer that remain with the seller and have not been shipped. Reserved units are included until they are shipped.

**Reserved Inventory**:
The number of physical inventory units assigned to an order and unavailable for another purchase until released or shipped.

**Available-to-Sell Inventory**:
The number of units not yet assigned to an order, equal to physical inventory minus reserved inventory.

**Carrier Handoff**:
The transfer of a prepared parcel to a carrier for delivery to the buyer. This is distinct from delivery of the goods to the buyer.

**Delivery Coverage Area**:
The set of buyer delivery destinations where the marketplace accepts orders. For the pilot, this is represented by a configurable list of postal codes; only destinations with trackable shipping, returns, and active support are enabled.

**Return**:
The process of sending back goods the buyer has received for inspection or resolution.
_Avoid_: Return of goods (when referring to the formal return process)

**Return Request**:
A buyer's request to return all or part of the quantity in a delivered order line, whether to withdraw from the purchase or to address a defect, discrepancy, or incorrect shipment. The original order quantity remains unchanged, and the request outcome is recorded separately.

**Return Status**:
A separate summary of the request's handling and the number of units accepted and returned, independent of parcel delivery status. A partial return means some of the ordered units have been returned; a full return means all units in the relevant order scope have been accepted and returned.

**Buyer Order Payment**:
The payment of the total amount for a buyer order in a single checkout, with amounts attributable to each seller suborder.

**Refund**:
The return of all or part of an amount paid for an order, such as after cancellation or an accepted return.

**Support Case**:
A buyer request or issue that is recorded and tracked with an owner and handling status, and linked to an order, suborder, payment, or return when relevant.

**Operational Data**:
Personal data needed to fulfill or track an active order, delivery, return, or support case. When the operational need ends, the data can be deleted or anonymized.

**Commercial and Financial History**:
The minimum transaction, payment, refund, commission, or settlement information retained as financial evidence and for recordkeeping. It is separate from operational data and support content and includes only the necessary identifying information.

**Seller Settlement**:
Payment of the seller's balance after accounting for the amounts of goods kept by buyers, commissions, and related refunds.
