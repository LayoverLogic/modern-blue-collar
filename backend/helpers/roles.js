/**
 * helpers/roles.js — the single role matrix for the API.
 *
 * Roles (User.role):
 *   super-admin  everything, including managing admins / super-admins
 *   admin        everything except creating/editing/deleting admins and super-admins
 *   dispatcher   office work: customers, jobs, scheduling/assignment, comms, SMS.
 *                No pricing (price book, quotes, invoices) and no deletes.
 *   office       same as dispatcher (back-office staff)
 *   technician   field: reads only their own jobs and the customers on them,
 *                updates status/notes and photos of their own jobs, logs comms
 *                for their customers. No deletes, no pricing, no SMS.
 *
 * Route guards use the groups below with requireRole(...GROUP).
 */
const ROLES = ['super-admin', 'admin', 'dispatcher', 'office', 'technician'];

const SUPER_ADMIN = ['super-admin'];
const ADMIN       = ['super-admin', 'admin'];              // deletes, price book, billing writes, exports, backups, keys
const OFFICE      = ['super-admin', 'admin', 'dispatcher', 'office']; // scheduling, customers, SMS, full reads
const BILLING     = ADMIN;                                  // quotes / invoices writes
const PRICING     = ADMIN;                                  // price book writes
const SMS         = OFFICE;                                 // SMS send
const PRIVILEGED  = ['super-admin', 'admin'];               // roles only a super-admin may grant / manage

const isRole      = (r) => ROLES.includes(r);
const isOffice    = (user) => !!user && OFFICE.includes(user.role);
const isAdmin     = (user) => !!user && ADMIN.includes(user.role);
const isSuper     = (user) => !!user && user.role === 'super-admin';
const isTechnician = (user) => !!user && user.role === 'technician';

module.exports = {
  ROLES, SUPER_ADMIN, ADMIN, OFFICE, BILLING, PRICING, SMS, PRIVILEGED,
  isRole, isOffice, isAdmin, isSuper, isTechnician,
};
