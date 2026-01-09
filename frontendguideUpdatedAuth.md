# Frontend Developer's Guide to the Fortunate Business Management Auth System

Hello! This guide details the new authentication and authorization system that has been implemented in the backend. It's designed to be powerful, scalable, and granular, giving the `SUPER_ADMIN` precise control over what each user can do.

---

### 1. Overview & Core Concepts

The goal of this system is to move from a simple login to a full-fledged Role-Based Access Control (RBAC) system tailored to our specific business needs.

**The core concepts are:**

*   **Users:** Created and managed *only* by a `SUPER_ADMIN`. There is no public sign-up.
*   **Authentication:** A standard email/password login that returns an `httpOnly` cookie containing a JWT. The frontend doesn't need to manage the token directly.
*   **Authorization:** This is the heart of the system and is based on two main properties of a user:
    1.  **Warehouse Access:** A user is explicitly granted access to one or more warehouses. They can only see or interact with data (like products) within the warehouses they are assigned to.
    2.  **Permissions:** A detailed list of what a user is allowed to do. Permissions are granular strings (e.g., `SALE_CREATE`, `LC_VIEW_DETAILS`, `CUSTOMER_DELETE`).

---

### 2. Architecture & How It Works

**The User Object:**
After login, when you fetch the user's profile, you will get a User object. The most important fields for the frontend are `roleName`, `warehouse`, and `access`.

```json
{
  "_id": "user_id_string",
  "name": "Test User",
  "email": "test@example.com",
  "roleName": "Sales Executive",
  "description": "Handles sales for the western region.",
  "warehouse": [
    "warehouse_id_1",
    "warehouse_id_2"
  ],
  "access": [
    {
      "module": "SALE",
      "permissions": [
        "SALE_VIEW_TABLE",
        "SALE_VIEW_DETAILS",
        "SALE_CREATE",
        "SALE_GENERATE_INVOICE", // This was automatically bundled!
        "SALE_VIEW_INVOICE",    // This was automatically bundled!
        "SALE_DOWNLOAD_INVOICE",// This was automatically bundled!
        "SALE_SHARE_INVOICE"    // This was automatically bundled!
      ]
    },
    {
      "module": "CUSTOMER",
      "permissions": [
        "CUSTOMER_VIEW_TABLE"
      ]
    }
  ]
}
```

**Key Architectural Points:**

*   **Centralized Permissions:** The backend has a master list of all possible permissions (e.g., `USER_CREATE`, `PRODUCT_UPDATE`, `TRASH_RESTORE_LC`). The `SUPER_ADMIN` will choose from this list in the UI you build.
*   **Bundled Permissions:** To make administration easier, some permissions automatically grant others on the backend. For example, when the `SUPER_ADMIN` grants a user `SALE_VIEW_DETAILS`, the backend automatically adds `SALE_GENERATE_INVOICE`, `SALE_VIEW_INVOICE`, etc., to that user's profile. **The frontend does not need to worry about this logic; it just needs to check for the final permission.**
*   **Specialized Middleware:** The backend has intelligent middleware that handles complex checks:
    *   `authorizeWarehouseAccess`: For product routes, this checks if the user has access to the warehouse *and* if they have the needed product permission (e.g., `PRODUCT_CREATE`).
    *   `authorizeTrashAccess`: For the trash can, this dynamically checks permissions based on the model being accessed (e.g., `TRASH_VIEW_LC`, `TRASH_RESTORE_PRODUCT`).

---

### 3. API Endpoints & Frontend Workflow

Here are the key endpoints and how to use them. All routes (except `/login`) require the `accessToken` cookie that is set on login.

#### **3.1. Authentication**

1.  **Login:**
    *   **Endpoint:** `POST /api/user/login`
    *   **Body:** `{ "email": "...", "password": "..." }`
    *   **Response:** On success, it sets the `httpOnly` cookie and returns a user object. Store this user object in your frontend state (React Context, etc.).

2.  **Get Current User Profile:**
    *   **Endpoint:** `GET /api/user/get-profile`
    *   **Usage:** Call this after login or on a page refresh to get the current user's data, including their all-important `access` and `warehouse` arrays.

3.  **Logout:**
    *   **Endpoint:** `POST /api/user/logout`
    *   **Usage:** Clears the authentication cookie.

#### **3.2. User Management (SUPER_ADMIN Only)**

These endpoints will return a `403 Forbidden` error if the logged-in user is not a `SUPER_ADMIN`.

1.  **Create a User:**
    *   **Endpoint:** `POST /api/user/create-user`
    *   **Body:** `{ "name": "...", "email": "...", "password": "...", "roleName": "...", "description": "..." }`

2.  **List All Users:**
    *   **Endpoint:** `GET /api/user/get-users`

3.  **Get a Specific User:**
    *   **Endpoint:** `GET /api/user/get-user/:id`
    *   **Usage:** Fetches a user's complete profile, including their `access` and `warehouse` arrays, which you need to populate the permissions dashboard.

4.  **Update a User (The Most Important Endpoint):**
    *   **Endpoint:** `PATCH /api/user/update-user/:id`
    *   **Usage:** This is how the `SUPER_ADMIN` assigns warehouses and permissions.
    *   **Example Request Body:**

    ```json
    {
      "roleName": "Warehouse Keeper",
      "warehouse": ["60d5f1b3e6e3c3a4f4b8b3a0", "60d5f1b3e6e3c3a4f4b8b3b1"],
      "access": [
        {
          "module": "PRODUCT",
          "permissions": [
            "PRODUCT_VIEW_TABLE",
            "PRODUCT_VIEW_DETAILS",
            "PRODUCT_CREATE"
          ]
        },
        {
          "module": "TRASH",
          "permissions": [
            "TRASH_VIEW_PRODUCT"
          ]
        }
      ]
    }
    ```

5.  **Delete a User:**
    *   **Endpoint:** `DELETE /api/user/delete-user/:id`

#### **3.3. How to Check Permissions in the UI**

The backend enforces all permissions. If a user makes an API call without the right permission, they'll get a `403 Forbidden` error. Your job on the frontend is to **show or hide UI elements** based on the user's permissions to provide a good user experience.

1.  **Store Permissions:** After login, get the user's `access` array and create a flat `Set` of all their permissions for fast lookups.

    ```javascript
    // Example in a login handler or context provider
    const userPermissions = new Set();
    const user = await api.getUserProfile(); // Fetches user data from backend
    user.access.forEach(module => {
      module.permissions.forEach(permission => {
        userPermissions.add(permission);
      });
    });
    // Store this 'userPermissions' Set in your state
    ```

2.  **Create a Helper Function:**

    ```javascript
    // In a utility file or context
    function hasPermission(permissionToCheck) {
      // Assuming 'userPermissions' is available from your state
      return userPermissions.has(permissionToCheck);
    }
    ```

3.  **Conditionally Render UI:**

    ```jsx
    // Example in a React component
    import { hasPermission } from './authUtils';

    function LCTable() {
      // ...
      return (
        <div>
          {hasPermission('LC_CREATE') && <Button>Create New LC</Button>}
          <table>
            {/* ... table rendering ... */}
          </table>
        </div>
      );
    }
    ```

---

### 4. Example Flow: Navigating to Products in a Warehouse

This flow demonstrates how warehouse access and product permissions work together.

1.  **User goes to "Stock Management" page.**
2.  **Frontend:** You have the user's `warehouse` array (e.g., `['warehouse_id_1', 'warehouse_id_2']`) from the profile. You will also need a list of all warehouses (from `GET /api/warehouses`). You then filter the full list to show only the warehouses the user has access to.
3.  **User clicks on "Warehouse A"** (which has ID `warehouse_id_1`).
4.  **Frontend:** You navigate to the product page for that warehouse and make an API call.
    *   **API Call:** `GET /api/warehouses/warehouse_id_1/products`
    *   **Backend Check:** The `authorizeWarehouseAccess` middleware runs. It checks two things:
        1.  Does this user have `warehouse_id_1` in their `user.warehouse` array? (Yes)
        2.  Does this user have the `PRODUCT_VIEW_TABLE` permission? (Let's assume yes)
    *   Since both are true, the API returns the list of products. If either were false, it would return a `403 Forbidden`.
5.  **On the Product Page:** A "Create Product" button is shown only because `hasPermission('PRODUCT_CREATE')` returns true. An "Update" button next to each product is shown only if `hasPermission('PRODUCT_UPDATE')` is true.

This guide should provide a clear path forward. The backend is now fully equipped to support the sophisticated, custom frontend experience you're building.
