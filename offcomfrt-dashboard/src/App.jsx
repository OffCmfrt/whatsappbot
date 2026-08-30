import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Plus, X, Search, AlertTriangle, CheckCircle2, Clock, Package,
  Factory, ClipboardList, MessageSquare, Ruler, Paperclip, LayoutDashboard,
  Trash2, Pencil, ExternalLink, ChevronDown, FileStack, Loader2, Truck,
} from "lucide-react";

/* ============================== CONSTANTS ============================== */
const CATEGORY_OPTIONS = ["T-Shirt", "Polo", "Henley", "Knitwear", "Sweatshirt", "Shorts", "Other"];
const TYPE_OPTIONS = ["Fit Sample", "Proto Sample", "Revision Sample", "Pre-Production Sample", "Photo Sample", "Counter Sample", "Size Set Sample"];
const STATUS_OPTIONS = ["Not Started", "Requested", "In Progress", "In Transit", "Received", "Under Review", "Revision Required", "Awaiting Manufacturer", "Awaiting Offcomfrt", "Approved", "Rejected", "Cancelled", "Closed"];
const STAGE_OPTIONS = ["Request", "Tech Pack", "Sampling", "Courier", "Fit Review", "Revision", "Approval", "Pre-Production", "Closed"];
const OWNER_OPTIONS = ["Offcomfrt Product", "Offcomfrt Founder", "Offcomfrt QC", "Offcomfrt Purchase", "Manufacturer", "Manufacturer Sampling", "Manufacturer Production"];
const WAITING_OPTIONS = ["Offcomfrt", "Manufacturer", "Courier", "Fabric Supplier", "Other"];
const APPROVAL_OPTIONS = ["Pending", "Approved", "Not Approved"];
const FIT_OPTIONS = ["Oversized", "Relaxed", "Regular", "Slim", "Boxy"];
const SIZE_OPTIONS = ["XS", "S", "M", "L", "XL", "XXL"];
const PAID_BY_OPTIONS = ["Offcomfrt", "Manufacturer", "Shared"];
const PAYMENT_STATUS_OPTIONS = ["Paid", "Partially Paid", "Pending", "Not Invoiced"];
const FILE_TYPE_OPTIONS = ["Tech Pack", "Front Photo", "Back Photo", "Detail Photo", "Fit Photo", "QC Photo", "Fabric Photo", "Reference Image", "Invoice", "Courier", "Other"];
const COMM_STATUS_OPTIONS = ["Open", "Waiting for Manufacturer", "Waiting for Offcomfrt", "Done", "Escalated"];
const REVISION_STATUS_OPTIONS = ["Not Started", "In Progress", "Completed", "Overdue"];
const TP_STATUS_OPTIONS = ["Draft", "Sent to Manufacturer", "Manufacturer Reviewing", "Questions Raised", "Revision Required", "Approved", "Archived"];
const PROD_STAGE_OPTIONS = ["PO Placed", "Fabric Sourcing", "Cutting", "Stitching", "Washing & Finishing", "Quality Check", "Packing", "Shipped", "Delivered"];
const PROD_PAYMENT_OPTIONS = ["Pending", "Advance Paid", "Partially Paid", "Fully Paid"];
const PROD_FILE_TYPE_OPTIONS = ["Purchase Order", "Invoice", "Packing List", "Shipping Bill", "Inspection Report", "Photo", "Other"];
const PROD_QC_RESULT_OPTIONS = ["Pending", "Pass", "Fail", "Hold"];
const PROD_QC_CHECKPOINTS = ["Inline Inspection", "Pre-Final Inspection", "Final Random Inspection (AQL 2.5)", "Other"];

const STORAGE_KEY = "offcomfrt_workspace_v1";

/* ============================== HELPERS ============================== */
const DAY = 86400000;
function todayISO() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString().slice(0, 10); }
function addDays(iso, n) { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function daysDiff(iso) { if (!iso) return null; const d = new Date(iso + "T00:00:00"); const t = new Date(todayISO() + "T00:00:00"); return Math.round((d - t) / DAY); }
function fmtDate(iso) { if (!iso) return "—"; const d = new Date(iso + "T00:00:00"); return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" }); }
function fmtINR(n) { if (n == null || isNaN(n)) return "₹0"; return "₹" + Math.round(n).toLocaleString("en-IN"); }
function uid(prefix) { return prefix + "-" + Math.random().toString(36).slice(2, 9).toUpperCase(); }

function statusLight(sample) {
  if (sample.stage === "Closed") return "grey";
  const due = sample.nextDue || sample.targetDate;
  const dr = daysDiff(due);
  if (dr == null) return "grey";
  if (dr < 0) return "red";
  if (dr <= 2) return "yellow";
  return "green";
}
function daysOpen(sample) {
  if (!sample.requestDate) return null;
  const end = (sample.stage === "Closed" && sample.dateReceived) ? sample.dateReceived : todayISO();
  return Math.round((new Date(end + "T00:00:00") - new Date(sample.requestDate + "T00:00:00")) / DAY);
}
function daysRemaining(sample) { return daysDiff(sample.nextDue || sample.targetDate); }
function daysOverdue(sample) {
  const dr = daysRemaining(sample);
  if (dr == null || sample.stage === "Closed") return 0;
  return dr < 0 ? -dr : 0;
}
function costTotal(c) {
  if (!c) return 0;
  return ["fabricCost", "trims", "cmt", "wash", "labels", "packaging", "courier", "other"]
    .reduce((s, k) => s + (Number(c[k]) || 0), 0);
}
function orderQty(order) { return (order.breakdown || []).reduce((s, r) => s + (Number(r.qty) || 0), 0); }
function orderValue(order) { return orderQty(order) * (Number(order.unitPrice) || 0); }
function orderBalance(order) { return orderValue(order) - (Number(order.advancePaid) || 0); }
function productionLight(order) {
  if (order.stage === "Delivered") return "grey";
  const dr = daysDiff(order.expectedDelivery);
  if (dr == null) return "grey";
  if (dr < 0) return "red";
  if (dr <= 5) return "yellow";
  return "green";
}
const LIGHT_DOT = { green: "bg-emerald-500", yellow: "bg-amber-500", red: "bg-rose-500", grey: "bg-neutral-300" };
const LIGHT_TEXT = { green: "text-emerald-700", yellow: "text-amber-700", red: "text-rose-700", grey: "text-neutral-500" };
const LIGHT_BG = { green: "bg-emerald-50", yellow: "bg-amber-50", red: "bg-rose-50", grey: "bg-neutral-100" };
const LIGHT_LABEL = { green: "On track", yellow: "Due soon", red: "Overdue", grey: "Closed" };

/* ============================== SEED DATA ============================== */
function seedWorkspace() {
  const t = todayISO();
  const mk = (n) => addDays(t, n);
  const manufacturers = [
    { id: uid("MFR"), name: "Shree Ganesh Knitters", location: "Tirupur, Tamil Nadu", contact: "Ramesh Kumar", phone: "+91 98765 43210", email: "ramesh@shreeganeshknitters.example", categories: "T-Shirts, Ringer Tees, Raglans", fabricCapabilities: "Cotton Jersey, Terry, Interlock", moq: "300 pcs/colour", sampleLeadTime: "7-9 days", bulkLeadTime: "25-30 days", qualityRating: 4, communicationRating: 4, notes: "" },
    { id: uid("MFR"), name: "Classic Apparel Works", location: "Tirupur, Tamil Nadu", contact: "Suresh Babu", phone: "+91 90000 11122", email: "suresh@classicapparelworks.example", categories: "Polos, Henleys", fabricCapabilities: "Pique Knit, Jersey", moq: "250 pcs/colour", sampleLeadTime: "8-10 days", bulkLeadTime: "30 days", qualityRating: 4, communicationRating: 3, notes: "" },
    { id: uid("MFR"), name: "Metro Fashion Exports", location: "Noida, Delhi NCR", contact: "Anita Rao", phone: "+91 98111 22334", email: "anita@metrofashionexports.example", categories: "Henleys, Sweatshirts, Knitwear", fabricCapabilities: "Slub Jersey, Fleece", moq: "200 pcs/colour", sampleLeadTime: "6-8 days", bulkLeadTime: "20-25 days", qualityRating: 5, communicationRating: 5, notes: "" },
    { id: uid("MFR"), name: "Comfort Knit Mills", location: "Ludhiana, Punjab", contact: "Harpreet Singh", phone: "+91 98765 00112", email: "harpreet@comfortknitmills.example", categories: "Knitwear, Waffle, Sweatshirts", fabricCapabilities: "Waffle Knit, French Terry", moq: "300 pcs/colour", sampleLeadTime: "9-12 days", bulkLeadTime: "30-35 days", qualityRating: 3, communicationRating: 3, notes: "" },
  ];

  const techPacks = [
    { id: "TP-RAGLAN001-V1", sku: "RAGLAN001", product: "Raglan Sleeve Tee 001", version: "V1", status: "Approved", link: "https://drive.google.com/DEMO-tp-raglan001-v1", createdBy: "Offcomfrt Product", createdDate: mk(-25), sentToManufacturer: true, manufacturerAcknowledged: true, manufacturerQuestions: "", revisionRequired: false, finalApproved: true, approvedDate: mk(-20), notes: "Superseded by V2" },
    { id: "TP-RAGLAN001-V2", sku: "RAGLAN001", product: "Raglan Sleeve Tee 001", version: "V2", status: "Revision Required", link: "https://drive.google.com/DEMO-tp-raglan001-v2", createdBy: "Offcomfrt Product", createdDate: mk(-14), sentToManufacturer: true, manufacturerAcknowledged: true, manufacturerQuestions: "None", revisionRequired: true, finalApproved: false, approvedDate: null, notes: "Superseded by V3" },
    { id: "TP-RAGLAN001-V3", sku: "RAGLAN001", product: "Raglan Sleeve Tee 001", version: "V3", status: "Sent to Manufacturer", link: "https://drive.google.com/DEMO-tp-raglan001-v3", createdBy: "Offcomfrt Product", createdDate: mk(-9), sentToManufacturer: true, manufacturerAcknowledged: true, manufacturerQuestions: "None", revisionRequired: false, finalApproved: false, approvedDate: null, notes: "Current active version" },
    { id: "TP-POLO001-V1", sku: "POLO001", product: "Classic Polo 001", version: "V1", status: "Sent to Manufacturer", link: "https://drive.google.com/DEMO-tp-polo001-v1", createdBy: "Offcomfrt Product", createdDate: mk(-11), sentToManufacturer: true, manufacturerAcknowledged: true, manufacturerQuestions: "Placket length to confirm", revisionRequired: false, finalApproved: false, approvedDate: null, notes: "" },
    { id: "TP-HENLEY001-V1", sku: "HENLEY001", product: "Henley 001", version: "V1", status: "Approved", link: "https://drive.google.com/DEMO-tp-henley001-v1", createdBy: "Offcomfrt Product", createdDate: mk(-31), sentToManufacturer: true, manufacturerAcknowledged: true, manufacturerQuestions: "", revisionRequired: false, finalApproved: true, approvedDate: mk(-19), notes: "Used for PP sample too" },
    { id: "TP-WAFFLEHENLEY-V1", sku: "WAFFLEHENLEY", product: "Waffle Henley", version: "V1", status: "Manufacturer Reviewing", link: "https://drive.google.com/DEMO-tp-wafflehenley-v1", createdBy: "Offcomfrt Product", createdDate: mk(-6), sentToManufacturer: true, manufacturerAcknowledged: false, manufacturerQuestions: "", revisionRequired: false, finalApproved: false, approvedDate: null, notes: "" },
    { id: "TP-RINGERTEE-V1", sku: "RINGERTEE", product: "Ringer Tee", version: "V1", status: "Revision Required", link: "https://drive.google.com/DEMO-tp-ringertee-v1", createdBy: "Offcomfrt Product", createdDate: mk(-27), sentToManufacturer: true, manufacturerAcknowledged: true, manufacturerQuestions: "", revisionRequired: true, finalApproved: false, approvedDate: null, notes: "Trim colour + fabric spec wrong" },
    { id: "TP-RINGERTEE-V2", sku: "RINGERTEE", product: "Ringer Tee", version: "V2", status: "Draft", link: "https://drive.google.com/DEMO-tp-ringertee-v2", createdBy: "Offcomfrt Product", createdDate: mk(0), sentToManufacturer: false, manufacturerAcknowledged: false, manufacturerQuestions: "", revisionRequired: false, finalApproved: false, approvedDate: null, notes: "Being finalised this week" },
  ];

  const samples = [
    {
      id: "OFC-RAGLAN001-S1", sku: "RAGLAN001", product: "Raglan Sleeve Tee 001", category: "T-Shirt", version: "S1", type: "Fit Sample",
      requestDate: mk(-20), targetDate: mk(-10), manufacturer: "Shree Ganesh Knitters", manufacturerContact: "Ramesh Kumar - +91 98765 43210",
      fabric: "220 GSM Cotton Terry", gsm: 220, composition: "100% Cotton", color: "Off White", size: "L", fit: "Oversized",
      techPackId: "TP-RAGLAN001-V1", refLink: "https://drive.google.com/DEMO-raglan001-reference",
      cost: { fabricCost: 380, trims: 40, cmt: 250, wash: 60, labels: 25, packaging: 15, courier: 90, other: 0, paidBy: "Offcomfrt", paymentStatus: "Paid", invoiceLink: "https://drive.google.com/DEMO-invoice-raglan001-s1" },
      courierAwb: "Delhivery 771122334", dateSent: mk(-19), dateReceived: mk(-11),
      status: "Received", stage: "Fit Review",
      mfrUpdate: "First proto received. Awaiting internal fit review.", feedback: "Reviewing fit internally before responding.",
      changesRequired: "", nextAction: "Complete internal fit review", actionOwner: "Offcomfrt QC", waitingOn: "Offcomfrt", nextDue: mk(7),
      approvalStatus: "Pending", approvedBy: "", approvalDate: null, finalDecision: "", notes: "Baseline raglan block for the season",
      qc: [
        { id: uid("QC"), point: "Body Length", spec: 71, tolerance: 0.5, actual: 71.3, mfrComment: "", ofcComment: "" },
        { id: uid("QC"), point: "Chest Width", spec: 58, tolerance: 0.5, actual: 58.4, mfrComment: "", ofcComment: "" },
        { id: uid("QC"), point: "Sleeve Opening", spec: 17, tolerance: 0.3, actual: 17.1, mfrComment: "", ofcComment: "" },
      ],
      revisions: [],
      comms: [
        { id: uid("COM"), date: mk(-16), from: "Offcomfrt QC", to: "Shree Ganesh Knitters", message: "Body length running long and sleeve opening loose on S1 — please confirm cutting pattern used", response: "Confirmed pattern was graded incorrectly for size L", decision: "Manufacturer to re-cut with corrected pattern for S2", actionOwner: "Manufacturer", dueDate: mk(-10), status: "Done" },
      ],
      files: [
        { id: uid("FL"), type: "Tech Pack", description: "V1 tech pack used for first proto", link: "https://drive.google.com/DEMO-tp-raglan001-v1", uploadedBy: "Offcomfrt Product", date: mk(-25) },
        { id: uid("FL"), type: "Front Photo", description: "S1 front view", link: "https://drive.google.com/DEMO-photo-raglan001-s1-front", uploadedBy: "Shree Ganesh Knitters", date: mk(-11) },
      ],
    },
    {
      id: "OFC-RAGLAN001-S2", sku: "RAGLAN001", product: "Raglan Sleeve Tee 001", category: "T-Shirt", version: "S2", type: "Revision Sample",
      requestDate: mk(-14), targetDate: mk(-4), manufacturer: "Shree Ganesh Knitters", manufacturerContact: "Ramesh Kumar - +91 98765 43210",
      fabric: "220 GSM Cotton Terry", gsm: 220, composition: "100% Cotton", color: "Off White", size: "L", fit: "Oversized",
      techPackId: "TP-RAGLAN001-V2", refLink: "https://drive.google.com/DEMO-raglan001-reference",
      cost: { fabricCost: 380, trims: 40, cmt: 250, wash: 60, labels: 25, packaging: 15, courier: 90, other: 0, paidBy: "Offcomfrt", paymentStatus: "Paid", invoiceLink: "https://drive.google.com/DEMO-invoice-raglan001-s2" },
      courierAwb: "Delhivery 774455667", dateSent: mk(-13), dateReceived: mk(-5),
      status: "Revision Required", stage: "Revision",
      mfrUpdate: "Second proto sent for review.", feedback: "Sleeve opening still loose, body length 1cm too long.",
      changesRequired: "Reduce sleeve opening by 1cm; reduce body length by 1cm",
      nextAction: "Send revision comments + corrected measurement chart to manufacturer", actionOwner: "Offcomfrt Product", waitingOn: "Offcomfrt", nextDue: mk(1),
      approvalStatus: "Not Approved", approvedBy: "", approvalDate: null, finalDecision: "", notes: "2nd round underway",
      qc: [
        { id: uid("QC"), point: "Body Length", spec: 71, tolerance: 0.5, actual: 72.2, mfrComment: "Ran slightly long on second cut", ofcComment: "Body length must be within +/-0.5cm of spec" },
        { id: uid("QC"), point: "Sleeve Opening", spec: 17, tolerance: 0.3, actual: 17.9, mfrComment: "Sleeve opening loose per buyer feedback", ofcComment: "Reduce sleeve opening by 1cm" },
        { id: uid("QC"), point: "Chest Width", spec: 58, tolerance: 0.5, actual: 58.3, mfrComment: "", ofcComment: "" },
      ],
      revisions: [
        { id: uid("REV"), prevVersion: "S1", newVersion: "S2", date: mk(-16), issue: "Body length 0.8cm long vs spec, sleeve opening loose", rootCause: "Pattern grading error at cutting stage", changeRequired: "Reduce body length by 1cm; tighten sleeve opening by 0.5cm", requestedBy: "Offcomfrt QC", mfrResponse: "Acknowledged, revised pattern in progress", expectedCompletion: mk(-6), completedDate: mk(-6), status: "Completed" },
      ],
      comms: [
        { id: uid("COM"), date: mk(-11), from: "Offcomfrt Product", to: "Shree Ganesh Knitters", message: "S2 still has loose sleeve opening and long body — was the V2 tech pack followed exactly?", response: "Apologies, correction was applied to the wrong pattern piece. Re-cutting now.", decision: "Manufacturer to produce S3 strictly per corrected V3 measurement chart", actionOwner: "Manufacturer", dueDate: mk(1), status: "Waiting for Manufacturer" },
      ],
      files: [],
    },
    {
      id: "OFC-RAGLAN001-S3", sku: "RAGLAN001", product: "Raglan Sleeve Tee 001", category: "T-Shirt", version: "S3", type: "Revision Sample",
      requestDate: mk(-9), targetDate: mk(0), manufacturer: "Shree Ganesh Knitters", manufacturerContact: "Ramesh Kumar - +91 98765 43210",
      fabric: "220 GSM Cotton Terry", gsm: 220, composition: "100% Cotton", color: "Off White", size: "L", fit: "Oversized",
      techPackId: "TP-RAGLAN001-V3", refLink: "https://drive.google.com/DEMO-raglan001-reference",
      cost: { fabricCost: 380, trims: 40, cmt: 250, wash: 60, labels: 25, packaging: 15, courier: 0, other: 0, paidBy: "Manufacturer", paymentStatus: "Not Invoiced", invoiceLink: "" },
      courierAwb: "", dateSent: null, dateReceived: null,
      status: "Awaiting Manufacturer", stage: "Sampling",
      mfrUpdate: "", feedback: "Corrected tech pack sent (V3) with updated sleeve + body length.",
      changesRequired: "Correct sleeve opening + reduce body length by 1 cm",
      nextAction: "Correct sleeve opening + reduce body length by 1 cm", actionOwner: "Manufacturer Sampling", waitingOn: "Manufacturer", nextDue: mk(0),
      approvalStatus: "Pending", approvedBy: "", approvalDate: null, finalDecision: "", notes: "3rd round - awaiting corrected sample",
      qc: [], revisions: [
        { id: uid("REV"), prevVersion: "S2", newVersion: "S3", date: mk(-11), issue: "Sleeve opening still loose after first correction, body length still 1cm long", rootCause: "Correction applied to wrong pattern piece", changeRequired: "Reduce sleeve opening by 1cm; reduce body length by 1cm", requestedBy: "Offcomfrt Product", mfrResponse: "Confirmed, re-cutting with corrected block", expectedCompletion: mk(0), completedDate: null, status: "In Progress" },
      ],
      comms: [], files: [],
    },
    {
      id: "OFC-POLO001-S1", sku: "POLO001", product: "Classic Polo 001", category: "Polo", version: "S1", type: "Fit Sample",
      requestDate: mk(-10), targetDate: mk(0), manufacturer: "Classic Apparel Works", manufacturerContact: "Suresh Babu - +91 90000 11122",
      fabric: "240 GSM Pique Knit", gsm: 240, composition: "100% Cotton", color: "Navy", size: "M", fit: "Regular",
      techPackId: "TP-POLO001-V1", refLink: "https://drive.google.com/DEMO-polo001-reference",
      cost: { fabricCost: 310, trims: 60, cmt: 280, wash: 50, labels: 25, packaging: 15, courier: 85, other: 0, paidBy: "Shared", paymentStatus: "Partially Paid", invoiceLink: "https://drive.google.com/DEMO-invoice-polo001-s1" },
      courierAwb: "DTDC 552211998", dateSent: mk(-9), dateReceived: mk(-1),
      status: "Under Review", stage: "Fit Review",
      mfrUpdate: "Proto delivered on schedule.", feedback: "Reviewing collar stance and placket alignment.",
      changesRequired: "", nextAction: "Complete fit review and share feedback", actionOwner: "Offcomfrt QC", waitingOn: "Offcomfrt", nextDue: mk(4),
      approvalStatus: "Pending", approvedBy: "", approvalDate: null, finalDecision: "", notes: "",
      qc: [
        { id: uid("QC"), point: "Body Length", spec: 70, tolerance: 0.5, actual: 70.2, mfrComment: "", ofcComment: "" },
        { id: uid("QC"), point: "Chest Width", spec: 54, tolerance: 0.5, actual: 54.6, mfrComment: "Collar stance slightly high", ofcComment: "Confirm collar stance against tech pack" },
      ],
      revisions: [], comms: [
        { id: uid("COM"), date: mk(-2), from: "Classic Apparel Works", to: "Offcomfrt QC", message: "Please confirm placket length — tech pack shows 11cm but reference image looks shorter", response: "11cm is correct, reference image was only indicative", decision: "Manufacturer to proceed with 11cm placket as per tech pack", actionOwner: "", dueDate: null, status: "Done" },
      ],
      files: [
        { id: uid("FL"), type: "Front Photo", description: "S1 front view", link: "https://drive.google.com/DEMO-photo-polo001-s1-front", uploadedBy: "Classic Apparel Works", date: mk(-1) },
      ],
    },
    {
      id: "OFC-HENLEY001-S1", sku: "HENLEY001", product: "Henley 001", category: "Henley", version: "S1", type: "Fit Sample",
      requestDate: mk(-31), targetDate: mk(-21), manufacturer: "Metro Fashion Exports", manufacturerContact: "Anita Rao - +91 98111 22334",
      fabric: "180 GSM Slub Jersey", gsm: 180, composition: "95% Cotton 5% Elastane", color: "Charcoal", size: "L", fit: "Relaxed",
      techPackId: "TP-HENLEY001-V1", refLink: "https://drive.google.com/DEMO-henley001-reference",
      cost: { fabricCost: 340, trims: 90, cmt: 300, wash: 55, labels: 25, packaging: 15, courier: 95, other: 0, paidBy: "Offcomfrt", paymentStatus: "Paid", invoiceLink: "https://drive.google.com/DEMO-invoice-henley001-s1" },
      courierAwb: "BlueDart 881122556", dateSent: mk(-30), dateReceived: mk(-22),
      status: "Approved", stage: "Closed",
      mfrUpdate: "Final sample delivered and matches tech pack.", feedback: "Approved for bulk. Great execution.",
      changesRequired: "", nextAction: "", actionOwner: "", waitingOn: "", nextDue: null,
      approvalStatus: "Approved", approvedBy: "Founder - Aditya", approvalDate: mk(-19), finalDecision: "Proceed to bulk order", notes: "Approved - moving to pre-production sample",
      qc: [
        { id: uid("QC"), point: "Body Length", spec: 73, tolerance: 0.5, actual: 73.1, mfrComment: "", ofcComment: "" },
        { id: uid("QC"), point: "Chest Width", spec: 60, tolerance: 0.5, actual: 60.2, mfrComment: "", ofcComment: "" },
      ],
      revisions: [], comms: [], files: [
        { id: uid("FL"), type: "QC Photo", description: "Final approved QC photo set", link: "https://drive.google.com/DEMO-photo-henley001-s1-qc", uploadedBy: "Offcomfrt QC", date: mk(-21) },
      ],
    },
    {
      id: "OFC-HENLEY001-S2", sku: "HENLEY001", product: "Henley 001", category: "Henley", version: "S2", type: "Pre-Production Sample",
      requestDate: mk(-7), targetDate: mk(3), manufacturer: "Metro Fashion Exports", manufacturerContact: "Anita Rao - +91 98111 22334",
      fabric: "180 GSM Slub Jersey", gsm: 180, composition: "95% Cotton 5% Elastane", color: "Charcoal", size: "L", fit: "Relaxed",
      techPackId: "TP-HENLEY001-V1", refLink: "https://drive.google.com/DEMO-henley001-reference",
      cost: { fabricCost: 340, trims: 90, cmt: 320, wash: 55, labels: 25, packaging: 15, courier: 95, other: 0, paidBy: "Offcomfrt", paymentStatus: "Pending", invoiceLink: "" },
      courierAwb: "BlueDart 881199222", dateSent: mk(-6), dateReceived: null,
      status: "In Transit", stage: "Courier",
      mfrUpdate: "PP sample dispatched.", feedback: "", changesRequired: "",
      nextAction: "Track courier and inspect on arrival", actionOwner: "Offcomfrt Purchase", waitingOn: "Courier", nextDue: mk(5),
      approvalStatus: "Pending", approvedBy: "", approvalDate: null, finalDecision: "", notes: "",
      qc: [], revisions: [], comms: [
        { id: uid("COM"), date: mk(-6), from: "Metro Fashion Exports", to: "Offcomfrt Purchase", message: "Pre-production sample dispatched today via BlueDart", response: "Noted, will inspect on arrival", decision: "", actionOwner: "Offcomfrt Purchase", dueDate: mk(5), status: "Open" },
      ], files: [],
    },
    {
      id: "OFC-WAFFLEHENLEY-S1", sku: "WAFFLEHENLEY", product: "Waffle Henley", category: "Knitwear", version: "S1", type: "Fit Sample",
      requestDate: mk(-5), targetDate: mk(9), manufacturer: "Comfort Knit Mills", manufacturerContact: "Harpreet Singh - +91 98765 00112",
      fabric: "Waffle Knit Cotton", gsm: 260, composition: "100% Cotton", color: "Stone Grey", size: "M", fit: "Relaxed",
      techPackId: "TP-WAFFLEHENLEY-V1", refLink: "https://drive.google.com/DEMO-wafflehenley-reference",
      cost: { fabricCost: 420, trims: 45, cmt: 310, wash: 60, labels: 25, packaging: 15, courier: 0, other: 0, paidBy: "Manufacturer", paymentStatus: "Not Invoiced", invoiceLink: "" },
      courierAwb: "", dateSent: null, dateReceived: null,
      status: "In Progress", stage: "Sampling",
      mfrUpdate: "Fabric sourced, cutting in progress.", feedback: "", changesRequired: "",
      nextAction: "Follow up on sampling timeline", actionOwner: "Manufacturer Sampling", waitingOn: "Manufacturer", nextDue: mk(3),
      approvalStatus: "Pending", approvedBy: "", approvalDate: null, finalDecision: "", notes: "",
      qc: [], revisions: [], comms: [], files: [
        { id: uid("FL"), type: "Reference Image", description: "Inspiration board for waffle texture", link: "https://drive.google.com/DEMO-ref-wafflehenley", uploadedBy: "Offcomfrt Product", date: mk(-5) },
      ],
    },
    {
      id: "OFC-RINGERTEE-S1", sku: "RINGERTEE", product: "Ringer Tee", category: "T-Shirt", version: "S1", type: "Fit Sample",
      requestDate: mk(-20), targetDate: mk(-11), manufacturer: "Shree Ganesh Knitters", manufacturerContact: "Ramesh Kumar - +91 98765 43210",
      fabric: "180 GSM Combed Cotton", gsm: 180, composition: "100% Cotton", color: "Black/White", size: "L", fit: "Regular",
      techPackId: "TP-RINGERTEE-V1", refLink: "https://drive.google.com/DEMO-ringertee-reference",
      cost: { fabricCost: 300, trims: 55, cmt: 240, wash: 45, labels: 25, packaging: 15, courier: 88, other: 20, paidBy: "Offcomfrt", paymentStatus: "Paid", invoiceLink: "https://drive.google.com/DEMO-invoice-ringertee-s1" },
      courierAwb: "Delhivery 776655443", dateSent: mk(-19), dateReceived: mk(-11),
      status: "Rejected", stage: "Revision",
      mfrUpdate: "First proto submitted.", feedback: "Ringer trim colour is navy, spec calls for black. Fabric hand-feel too stiff.",
      changesRequired: "Correct ringer trim colour to black; resource softer fabric",
      nextAction: "Send corrected tech pack (V2) and approved fabric swatch", actionOwner: "Offcomfrt Product", waitingOn: "Offcomfrt", nextDue: mk(-11),
      approvalStatus: "Not Approved", approvedBy: "", approvalDate: null, finalDecision: "", notes: "Overdue on our side - prioritise this week",
      qc: [
        { id: uid("QC"), point: "Body Length", spec: 70, tolerance: 0.5, actual: 70.1, mfrComment: "", ofcComment: "" },
        { id: uid("QC"), point: "Ringer Trim Colour", spec: null, tolerance: null, actual: null, mfrComment: "Used navy ringer trim instead of black", ofcComment: "Correct ringer trim colour to black" },
      ],
      revisions: [
        { id: uid("REV"), prevVersion: "S1", newVersion: "S2", date: mk(-8), issue: "Ringer trim colour incorrect (navy instead of black), fabric too stiff", rootCause: "Manufacturer substituted fabric batch without approval", changeRequired: "Correct ringer trim colour to black; re-source approved fabric", requestedBy: "Offcomfrt Product", mfrResponse: "Awaiting approved fabric swatch from Offcomfrt", expectedCompletion: mk(6), completedDate: null, status: "Overdue" },
      ],
      comms: [
        { id: uid("COM"), date: mk(-8), from: "Offcomfrt Product", to: "Shree Ganesh Knitters", message: "Ringer trim colour received is navy, tech pack specifies black. Fabric also feels stiffer than approved swatch.", response: "We substituted fabric batch due to stock shortage, will revert.", decision: "Offcomfrt to send approved fabric swatch reference before re-sampling", actionOwner: "Offcomfrt Purchase", dueDate: mk(3), status: "Waiting for Offcomfrt" },
      ],
      files: [
        { id: uid("FL"), type: "Fabric Photo", description: "Fabric swatch received vs approved swatch comparison", link: "https://drive.google.com/DEMO-photo-ringertee-s1-fabric", uploadedBy: "Offcomfrt QC", date: mk(-11) },
      ],
    },
  ];

  const productionOrders = [
    {
      id: "PO-HENLEY001-B1", sampleId: "OFC-HENLEY001-S1", sku: "HENLEY001", product: "Henley 001", category: "Henley",
      manufacturer: "Metro Fashion Exports", manufacturerContact: "Anita Rao - +91 98111 22334",
      poDate: mk(-18), expectedDelivery: mk(9), actualDelivery: null,
      breakdown: [
        { id: uid("QTY"), size: "S", color: "Charcoal", qty: 100 },
        { id: uid("QTY"), size: "M", color: "Charcoal", qty: 150 },
        { id: uid("QTY"), size: "L", color: "Charcoal", qty: 150 },
        { id: uid("QTY"), size: "XL", color: "Charcoal", qty: 100 },
      ],
      unitPrice: 420, advancePaid: 84000, paymentStatus: "Advance Paid",
      currentStage: "Stitching", actionOwner: "Offcomfrt Purchase", waitingOn: "Manufacturer",
      nextAction: "Confirm cutting complete and share inline inspection photos", nextActionDue: mk(2),
      shippingMethod: "Road Freight", trackingNumber: "", notes: "First bulk order for Henley 001 after S1 approval.",
      qc: [
        { id: uid("PQC"), checkpoint: "Inline Inspection", date: mk(-2), inspector: "Offcomfrt QC", result: "Pass", defectRate: 1.2, comments: "Stitching quality within tolerance on first batch." },
      ],
      comms: [
        { id: uid("COM"), date: mk(-18), from: "Offcomfrt Purchase", to: "Metro Fashion Exports", message: "Confirming PO for 500 pcs Henley 001 per approved S1 sample.", response: "Confirmed, fabric sourcing starting this week.", decision: "Target delivery in 4 weeks", actionOwner: "Manufacturer", dueDate: mk(9), status: "Waiting for Manufacturer" },
      ],
      files: [
        { id: uid("FL"), type: "Purchase Order", description: "Signed PO copy", link: "https://drive.google.com/DEMO-po-henley001-b1", uploadedBy: "Offcomfrt Purchase", date: mk(-18) },
      ],
    },
  ];

  return { samples, manufacturers, techPacks, productionOrders, updatedAt: new Date().toISOString() };
}

/* ============================== SMALL UI PRIMITIVES ============================== */
function Dot({ light }) {
  return <span className={`inline-block w-2 h-2 rounded-full ${LIGHT_DOT[light]}`} />;
}

function StatusPill({ light }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium rounded-sm ${LIGHT_BG[light]} ${LIGHT_TEXT[light]}`}>
      <Dot light={light} /> {LIGHT_LABEL[light]}
    </span>
  );
}

function Field({ label, children, span }) {
  return (
    <label className={`flex flex-col gap-1 ${span ? "col-span-2" : ""}`}>
      <span className="text-[10px] font-semibold tracking-wider uppercase text-neutral-400">{label}</span>
      {children}
    </label>
  );
}

const inputCls = "w-full border border-neutral-300 rounded-sm px-2.5 py-1.5 text-sm text-neutral-900 bg-white focus:outline-none focus:ring-1 focus:ring-neutral-900 focus:border-neutral-900";
const selectCls = inputCls + " appearance-none";

function TextInput(props) { return <input {...props} className={inputCls + " " + (props.className || "")} />; }
function Select({ options, allowEmpty, className, ...props }) {
  return (
    <div className="relative">
      <select {...props} className={selectCls + " " + (className || "")}>
        {allowEmpty && <option value="">—</option>}
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      <ChevronDown size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400" />
    </div>
  );
}
function TextArea(props) { return <textarea {...props} className={inputCls + " min-h-[52px] resize-y " + (props.className || "")} />; }

function EmptyState({ icon: Icon, title, hint, action }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 border border-dashed border-neutral-300 rounded-sm bg-neutral-50">
      <Icon size={22} className="text-neutral-300 mb-3" strokeWidth={1.5} />
      <p className="text-sm font-medium text-neutral-600">{title}</p>
      {hint && <p className="text-xs text-neutral-400 mt-1 max-w-xs">{hint}</p>}
      {action}
    </div>
  );
}

function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div className="fixed bottom-5 right-5 z-[100] bg-neutral-900 text-white text-sm px-4 py-2.5 rounded-sm shadow-lg flex items-center gap-2">
      {toast.kind === "error" ? <AlertTriangle size={14} className="text-rose-400" /> : <CheckCircle2 size={14} className="text-emerald-400" />}
      {toast.msg}
    </div>
  );
}

function ConfirmDialog({ data, onCancel, onConfirm }) {
  if (!data) return null;
  return (
    <div className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-sm w-full max-w-sm p-5 border border-neutral-200">
        <p className="text-sm font-semibold text-neutral-900 mb-1">{data.title}</p>
        <p className="text-sm text-neutral-500 mb-4">{data.message}</p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-sm rounded-sm border border-neutral-300 hover:bg-neutral-50">Cancel</button>
          <button onClick={onConfirm} className="px-3 py-1.5 text-sm rounded-sm bg-rose-600 text-white hover:bg-rose-700">Delete</button>
        </div>
      </div>
    </div>
  );
}

function SectionHeading({ index, children, action }) {
  return (
    <div className="flex items-center justify-between mb-3 mt-8 first:mt-0">
      <h2 className="text-[13px] font-bold tracking-wide text-neutral-900 flex items-baseline gap-2">
        <span className="text-neutral-300 font-mono">{index}</span>
        <span className="uppercase">{children}</span>
      </h2>
      {action}
    </div>
  );
}

/* ============================== DASHBOARD ============================== */
function KpiCard({ label, value, mono = true, accent }) {
  return (
    <div className="px-4 py-3 border-r border-neutral-200 last:border-r-0">
      <div className="text-[10px] font-semibold tracking-wider uppercase text-neutral-400 mb-1">{label}</div>
      <div className={`text-2xl font-black ${mono ? "font-mono tabular-nums" : ""} ${accent || "text-neutral-900"}`}>{value}</div>
    </div>
  );
}

function Bar({ label, count, max, colorClass = "bg-neutral-800" }) {
  const pct = max > 0 ? Math.max(3, Math.round((count / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="w-28 text-xs text-neutral-600 shrink-0">{label}</div>
      <div className="flex-1 h-4 bg-neutral-100 rounded-sm overflow-hidden">
        <div className={`h-full ${colorClass} rounded-sm transition-all`} style={{ width: pct + "%" }} />
      </div>
      <div className="w-6 text-xs font-mono text-neutral-700 text-right shrink-0">{count}</div>
    </div>
  );
}

function Dashboard({ samples, manufacturers, productionOrders, onOpenSample, onOpenOrder }) {
  const [fMfr, setFMfr] = useState("All");
  const [fCat, setFCat] = useState("All");

  const scoped = useMemo(() => samples.filter((s) =>
    (fMfr === "All" || s.manufacturer === fMfr) && (fCat === "All" || s.category === fCat)
  ), [samples, fMfr, fCat]);

  const active = scoped.filter((s) => s.stage !== "Closed");
  const overdue = scoped.filter((s) => statusLight(s) === "red");
  const dueThisWeek = active.filter((s) => { const d = daysRemaining(s); return d != null && d >= 0 && d <= 7; });
  const kpis = [
    { label: "Total Active Samples", value: active.length },
    { label: "Due This Week", value: dueThisWeek.length },
    { label: "Overdue", value: overdue.length, accent: overdue.length ? "text-rose-600" : undefined },
    { label: "Awaiting Manufacturer", value: scoped.filter((s) => s.status === "Awaiting Manufacturer").length },
    { label: "Awaiting Offcomfrt", value: scoped.filter((s) => s.status === "Awaiting Offcomfrt").length },
    { label: "Under Review", value: scoped.filter((s) => s.status === "Under Review").length },
    { label: "Approved", value: scoped.filter((s) => s.approvalStatus === "Approved").length },
    { label: "Requiring Revision", value: scoped.filter((s) => s.status === "Revision Required").length },
    { label: "Avg Turnaround (days)", value: (() => { const c = scoped.filter((s) => s.stage === "Closed"); if (!c.length) return "—"; return Math.round(c.reduce((a, s) => a + (daysOpen(s) || 0), 0) / c.length); })() },
    { label: "Total Sample Dev Cost", value: fmtINR(scoped.reduce((a, s) => a + costTotal(s.cost), 0)) },
  ];

  const STAGE_LIST = STAGE_OPTIONS;
  const stageCounts = STAGE_LIST.map((st) => ({ label: st, count: samples.filter((s) => s.stage === st).length }));
  const maxStage = Math.max(1, ...stageCounts.map((s) => s.count));

  const statusBuckets = [
    { label: "On Track", count: samples.filter((s) => statusLight(s) === "green").length, color: "bg-emerald-500" },
    { label: "Due Soon", count: samples.filter((s) => statusLight(s) === "yellow").length, color: "bg-amber-500" },
    { label: "Overdue", count: samples.filter((s) => statusLight(s) === "red").length, color: "bg-rose-500" },
    { label: "Blocked", count: samples.filter((s) => s.status === "Revision Required" || s.status === "Rejected").length, color: "bg-neutral-700" },
    { label: "Approved", count: samples.filter((s) => s.approvalStatus === "Approved").length, color: "bg-neutral-400" },
  ];

  const upcoming = useMemo(() => samples
    .filter((s) => s.stage !== "Closed" && daysRemaining(s) != null && daysRemaining(s) >= 0)
    .sort((a, b) => daysRemaining(a) - daysRemaining(b)).slice(0, 10), [samples]);

  const overdueList = useMemo(() => samples
    .filter((s) => statusLight(s) === "red")
    .sort((a, b) => daysOverdue(b) - daysOverdue(a)).slice(0, 10), [samples]);

  const mfrPerf = useMemo(() => manufacturers.map((m) => {
    const ms = samples.filter((s) => s.manufacturer === m.name);
    const completed = ms.filter((s) => s.stage === "Closed");
    const activeN = ms.filter((s) => s.stage !== "Closed").length;
    const avgT = completed.length ? Math.round(completed.reduce((a, s) => a + (daysOpen(s) || 0), 0) / completed.length) : null;
    const onTime = completed.length ? Math.round((completed.filter((s) => daysOverdue(s) === 0).length / completed.length) * 100) : null;
    const revRate = ms.length ? Math.round((ms.filter((s) => s.status === "Revision Required").length / ms.length) * 100) : 0;
    const approved = ms.filter((s) => s.approvalStatus === "Approved").length;
    return { name: m.name, active: activeN, completed: completed.length, avgT, onTime, revRate, approved };
  }), [samples, manufacturers]);

  const months = useMemo(() => {
    const arr = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const label = d.toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
      const start = new Date(d.getFullYear(), d.getMonth(), 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      const inRange = (iso) => { if (!iso) return false; const dd = new Date(iso + "T00:00:00"); return dd >= start && dd < end; };
      const requested = samples.filter((s) => inRange(s.requestDate)).length;
      const received = samples.filter((s) => inRange(s.dateReceived)).length;
      const approved = samples.filter((s) => inRange(s.approvalDate)).length;
      arr.push({ label, requested, received, approved });
    }
    return arr;
  }, [samples]);
  const maxMonth = Math.max(1, ...months.flatMap((m) => [m.requested, m.received, m.approved]));

  const costTotalAll = samples.reduce((a, s) => a + costTotal(s.cost), 0);
  const costByPaidBy = (who) => samples.filter((s) => s.cost?.paidBy === who).reduce((a, s) => a + costTotal(s.cost), 0);

  return (
    <div>
      {/* filters */}
      <div className="flex items-center gap-3 mb-5 text-xs">
        <span className="font-semibold tracking-wider uppercase text-neutral-400">Filters</span>
        <select value={fMfr} onChange={(e) => setFMfr(e.target.value)} className="border border-neutral-300 rounded-sm px-2 py-1 bg-white">
          <option>All</option>
          {manufacturers.map((m) => <option key={m.id}>{m.name}</option>)}
        </select>
        <select value={fCat} onChange={(e) => setFCat(e.target.value)} className="border border-neutral-300 rounded-sm px-2 py-1 bg-white">
          <option>All</option>
          {CATEGORY_OPTIONS.map((c) => <option key={c}>{c}</option>)}
        </select>
        <span className="text-neutral-400">applies to Key Metrics only</span>
      </div>

      <SectionHeading index="—">Key Metrics</SectionHeading>
      <div className="grid grid-cols-5 border border-neutral-200 rounded-sm bg-white divide-y divide-neutral-200">
        <div className="col-span-5 grid grid-cols-5">{kpis.slice(0, 5).map((k) => <KpiCard key={k.label} {...k} />)}</div>
        <div className="col-span-5 grid grid-cols-5 border-t border-neutral-200">{kpis.slice(5, 10).map((k) => <KpiCard key={k.label} {...k} />)}</div>
      </div>

      <div className="grid grid-cols-2 gap-6 mt-8">
        <div>
          <SectionHeading index="A">Sample Pipeline</SectionHeading>
          <div className="border border-neutral-200 rounded-sm bg-white p-4">
            {stageCounts.map((s) => <Bar key={s.label} label={s.label} count={s.count} max={maxStage} />)}
          </div>
        </div>
        <div>
          <SectionHeading index="B">Sample Status</SectionHeading>
          <div className="border border-neutral-200 rounded-sm bg-white p-4 grid grid-cols-2 gap-3">
            {statusBuckets.map((b) => (
              <div key={b.label} className="flex items-center gap-2.5 px-2 py-2">
                <span className={`w-2.5 h-2.5 rounded-full ${b.color}`} />
                <span className="text-xs text-neutral-600 flex-1">{b.label}</span>
                <span className="text-sm font-mono font-bold text-neutral-900">{b.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div>
          <SectionHeading index="C">Upcoming Deadlines — Next 10</SectionHeading>
          {upcoming.length === 0 ? <EmptyState icon={Clock} title="Nothing due" hint="No open samples have an upcoming due date." /> : (
            <div className="border border-neutral-200 rounded-sm bg-white overflow-hidden">
              {upcoming.map((s) => (
                <button key={s.id} onClick={() => onOpenSample(s)} className="w-full flex items-center gap-3 px-3 py-2 text-left border-b last:border-b-0 border-neutral-100 hover:bg-neutral-50">
                  <Dot light={statusLight(s)} />
                  <span className="font-mono text-[11px] text-neutral-500 w-32 truncate">{s.id}</span>
                  <span className="text-xs text-neutral-800 flex-1 truncate">{s.product} · {s.version}</span>
                  <span className="text-[11px] text-neutral-500 w-20">{s.actionOwner || "—"}</span>
                  <span className="text-xs font-mono text-neutral-700 w-16 text-right">{daysRemaining(s)}d</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <SectionHeading index="D">Overdue Samples</SectionHeading>
          {overdueList.length === 0 ? <EmptyState icon={CheckCircle2} title="Nothing overdue" hint="Every open sample is within its due date." /> : (
            <div className="border border-neutral-200 rounded-sm bg-white overflow-hidden">
              {overdueList.map((s) => (
                <button key={s.id} onClick={() => onOpenSample(s)} className="w-full flex items-center gap-3 px-3 py-2 text-left border-b last:border-b-0 border-neutral-100 hover:bg-rose-50/50">
                  <span className="font-mono text-[11px] text-neutral-500 w-32 truncate">{s.id}</span>
                  <span className="text-xs text-neutral-800 flex-1 truncate">{s.product}</span>
                  <span className="text-[11px] text-neutral-500 w-28 truncate">{s.manufacturer}</span>
                  <span className="text-xs font-mono text-rose-600 font-bold w-16 text-right">{daysOverdue(s)}d</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <SectionHeading index="E">Manufacturer Performance</SectionHeading>
      <div className="border border-neutral-200 rounded-sm bg-white overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-neutral-900 text-white text-[10px] uppercase tracking-wide">
              <th className="text-left font-semibold px-3 py-2">Manufacturer</th>
              <th className="text-right font-semibold px-3 py-2">Active</th>
              <th className="text-right font-semibold px-3 py-2">Completed</th>
              <th className="text-right font-semibold px-3 py-2">Avg Turnaround</th>
              <th className="text-right font-semibold px-3 py-2">On-Time %</th>
              <th className="text-right font-semibold px-3 py-2">Revision Rate</th>
              <th className="text-right font-semibold px-3 py-2">Approved</th>
            </tr>
          </thead>
          <tbody>
            {mfrPerf.map((m, i) => (
              <tr key={m.name} className={i % 2 ? "bg-neutral-50" : ""}>
                <td className="px-3 py-2 font-medium text-neutral-800">{m.name}</td>
                <td className="px-3 py-2 text-right font-mono">{m.active}</td>
                <td className="px-3 py-2 text-right font-mono">{m.completed}</td>
                <td className="px-3 py-2 text-right font-mono">{m.avgT ?? "—"}</td>
                <td className="px-3 py-2 text-right font-mono">{m.onTime != null ? m.onTime + "%" : "—"}</td>
                <td className="px-3 py-2 text-right font-mono">{m.revRate}%</td>
                <td className="px-3 py-2 text-right font-mono">{m.approved}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div>
          <SectionHeading index="F">Velocity — Last 6 Months</SectionHeading>
          <div className="border border-neutral-200 rounded-sm bg-white p-4">
            <div className="flex items-end gap-4 h-32">
              {months.map((m) => (
                <div key={m.label} className="flex-1 flex flex-col items-center gap-1">
                  <div className="flex items-end gap-0.5 h-24">
                    <div className="w-2 bg-neutral-800 rounded-t-sm" style={{ height: `${(m.requested / maxMonth) * 100}%` }} title={`Requested: ${m.requested}`} />
                    <div className="w-2 bg-neutral-400 rounded-t-sm" style={{ height: `${(m.received / maxMonth) * 100}%` }} title={`Received: ${m.received}`} />
                    <div className="w-2 bg-emerald-400 rounded-t-sm" style={{ height: `${(m.approved / maxMonth) * 100}%` }} title={`Approved: ${m.approved}`} />
                  </div>
                  <div className="text-[10px] text-neutral-400">{m.label}</div>
                </div>
              ))}
            </div>
            <div className="flex gap-4 mt-3 text-[10px] text-neutral-500">
              <span className="flex items-center gap-1"><span className="w-2 h-2 bg-neutral-800 rounded-sm" /> Requested</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 bg-neutral-400 rounded-sm" /> Received</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 bg-emerald-400 rounded-sm" /> Approved</span>
            </div>
          </div>
        </div>
        <div>
          <SectionHeading index="G">Cost Summary</SectionHeading>
          <div className="border border-neutral-200 rounded-sm bg-white grid grid-cols-2 divide-x divide-y divide-neutral-200">
            <KpiCard label="Total Sample Cost" value={fmtINR(costTotalAll)} />
            <KpiCard label="Avg Cost / Sample" value={fmtINR(samples.length ? costTotalAll / samples.length : 0)} />
            <KpiCard label="Manufacturer-Paid" value={fmtINR(costByPaidBy("Manufacturer"))} />
            <KpiCard label="Offcomfrt-Paid" value={fmtINR(costByPaidBy("Offcomfrt"))} />
          </div>
        </div>
      </div>

      <SectionHeading index="H">Production Snapshot</SectionHeading>
      {productionOrders.length === 0 ? (
        <EmptyState icon={Truck} title="No production orders yet" hint="Approve a sample and place your first bulk order from the Production tab." />
      ) : (
        <div className="border border-neutral-200 rounded-sm bg-white overflow-hidden">
          {productionOrders.slice().sort((a, b) => {
            const order = { red: 0, yellow: 1, green: 2, grey: 3 };
            return order[productionLight(a)] - order[productionLight(b)];
          }).map((o) => (
            <button key={o.id} onClick={() => onOpenOrder && onOpenOrder(o)} className="w-full flex items-center gap-4 px-4 py-2.5 text-left border-b last:border-b-0 border-neutral-100 hover:bg-neutral-50">
              <Dot light={productionLight(o)} />
              <span className="font-mono text-[11px] text-neutral-500 w-36 truncate">{o.id}</span>
              <span className="text-xs text-neutral-800 flex-1 truncate">{o.product} · {orderQty(o).toLocaleString("en-IN")} pcs</span>
              <span className="text-[11px] text-neutral-500 w-40 truncate">{o.manufacturer}</span>
              <span className="text-xs text-neutral-600 w-32">{o.currentStage}</span>
              <span className="text-xs font-mono text-neutral-500 w-24 text-right">{fmtDate(o.expectedDelivery)}</span>
              <span className="text-xs font-mono text-neutral-700 w-24 text-right">{fmtINR(orderValue(o))}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================== SAMPLES LIST ============================== */
function SamplesTable({ samples, manufacturers, onOpen, onNew, onDelete }) {
  const [q, setQ] = useState("");
  const [fMfr, setFMfr] = useState("All");
  const [fCat, setFCat] = useState("All");
  const [fStatus, setFStatus] = useState("All");

  const filtered = samples.filter((s) => {
    if (fMfr !== "All" && s.manufacturer !== fMfr) return false;
    if (fCat !== "All" && s.category !== fCat) return false;
    if (fStatus !== "All" && s.status !== fStatus) return false;
    if (q && !(`${s.id} ${s.product} ${s.sku}`.toLowerCase().includes(q.toLowerCase()))) return false;
    return true;
  }).sort((a, b) => {
    const order = { red: 0, yellow: 1, green: 2, grey: 3 };
    return order[statusLight(a)] - order[statusLight(b)];
  });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sample, product, SKU…"
            className="pl-8 pr-3 py-1.5 text-sm border border-neutral-300 rounded-sm w-64 focus:outline-none focus:ring-1 focus:ring-neutral-900" />
        </div>
        <select value={fMfr} onChange={(e) => setFMfr(e.target.value)} className="border border-neutral-300 rounded-sm px-2 py-1.5 text-xs bg-white">
          <option>All</option>{manufacturers.map((m) => <option key={m.id}>{m.name}</option>)}
        </select>
        <select value={fCat} onChange={(e) => setFCat(e.target.value)} className="border border-neutral-300 rounded-sm px-2 py-1.5 text-xs bg-white">
          <option>All</option>{CATEGORY_OPTIONS.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className="border border-neutral-300 rounded-sm px-2 py-1.5 text-xs bg-white">
          <option>All</option>{STATUS_OPTIONS.map((c) => <option key={c}>{c}</option>)}
        </select>
        <button onClick={onNew} className="ml-auto flex items-center gap-1.5 bg-neutral-900 text-white text-sm px-3 py-1.5 rounded-sm hover:bg-neutral-800">
          <Plus size={14} /> New Sample
        </button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Package} title="No samples match" hint="Try clearing filters, or add your first sample."
          action={<button onClick={onNew} className="mt-3 text-xs font-semibold text-neutral-900 underline">+ New sample</button>} />
      ) : (
        <div className="border border-neutral-200 rounded-sm bg-white overflow-hidden">
          {filtered.map((s) => {
            const light = statusLight(s);
            return (
              <div key={s.id} className="flex items-stretch border-b last:border-b-0 border-neutral-100 hover:bg-neutral-50 group">
                <div className={`w-1 ${LIGHT_DOT[light]} shrink-0`} />
                <button onClick={() => onOpen(s)} className="flex-1 flex items-center gap-4 px-4 py-3 text-left min-w-0">
                  <div className="w-40 shrink-0">
                    <div className="font-mono text-[11px] text-neutral-500 truncate">{s.id}</div>
                  </div>
                  <div className="w-52 shrink-0 min-w-0">
                    <div className="text-sm text-neutral-900 truncate">{s.product}</div>
                    <div className="text-[11px] text-neutral-400">{s.version} · {s.category}</div>
                  </div>
                  <div className="w-40 shrink-0 text-xs text-neutral-600 truncate">{s.manufacturer}</div>
                  <div className="w-28 shrink-0 text-xs text-neutral-600">{s.stage}</div>
                  <div className="w-36 shrink-0 text-xs text-neutral-600 truncate">{s.status}</div>
                  <div className="w-24 shrink-0 text-xs font-mono text-neutral-500">{fmtDate(s.nextDue || s.targetDate)}</div>
                  <div className="w-24 shrink-0"><StatusPill light={light} /></div>
                </button>
                <button onClick={() => onDelete(s)} className="px-3 opacity-0 group-hover:opacity-100 text-neutral-300 hover:text-rose-600 transition-opacity">
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================== SAMPLE DRAWER ============================== */
const emptySample = () => ({
  id: "", sku: "", product: "", category: "T-Shirt", version: "S1", type: "Fit Sample",
  requestDate: todayISO(), targetDate: "", manufacturer: "", manufacturerContact: "",
  fabric: "", gsm: "", composition: "", color: "", size: "M", fit: "Regular",
  techPackId: "", refLink: "",
  cost: { fabricCost: 0, trims: 0, cmt: 0, wash: 0, labels: 0, packaging: 0, courier: 0, other: 0, paidBy: "Offcomfrt", paymentStatus: "Pending", invoiceLink: "" },
  courierAwb: "", dateSent: "", dateReceived: "",
  status: "Requested", stage: "Request",
  mfrUpdate: "", feedback: "", changesRequired: "", nextAction: "", actionOwner: "Offcomfrt Product", waitingOn: "Offcomfrt", nextDue: "",
  approvalStatus: "Pending", approvedBy: "", approvalDate: "", finalDecision: "", notes: "",
  qc: [], revisions: [], comms: [], files: [],
});

const emptyProductionOrder = () => ({
  id: "", sampleId: "", sku: "", product: "", category: "T-Shirt", manufacturer: "", manufacturerContact: "",
  poDate: todayISO(), expectedDelivery: "", actualDelivery: "",
  breakdown: [], unitPrice: 0, advancePaid: 0, paymentStatus: "Pending",
  currentStage: "PO Placed", actionOwner: "Offcomfrt Purchase", waitingOn: "Manufacturer",
  nextAction: "", nextActionDue: "", shippingMethod: "", trackingNumber: "", notes: "",
  qc: [], comms: [], files: [],
});

function DrawerTabBtn({ active, onClick, icon: Icon, children, count }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px ${active ? "border-neutral-900 text-neutral-900" : "border-transparent text-neutral-400 hover:text-neutral-600"}`}>
      <Icon size={13} /> {children}{count != null && count > 0 ? <span className="ml-0.5 text-[10px] text-neutral-400">({count})</span> : null}
    </button>
  );
}

function SampleDrawer({ initial, isNew, manufacturers, techPacks, existingIds, onSave, onClose, onPlaceOrder }) {
  const [draft, setDraft] = useState(initial);
  const [tab, setTab] = useState("overview");
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const setCost = (patch) => setDraft((d) => ({ ...d, cost: { ...d.cost, ...patch } }));

  const listOp = {
    add: (key, blank) => setDraft((d) => ({ ...d, [key]: [...d[key], { id: uid(key.toUpperCase()), ...blank } ] })),
    update: (key, id, field, value) => setDraft((d) => ({ ...d, [key]: d[key].map((it) => it.id === id ? { ...it, [field]: value } : it) })),
    remove: (key, id) => setDraft((d) => ({ ...d, [key]: d[key].filter((it) => it.id !== id) })),
  };

  const idTaken = isNew && (existingIds || []).includes(draft.id.trim());
  const canSave = draft.id.trim() && draft.product.trim() && draft.manufacturer.trim() && !idTaken;

  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex justify-end">
      <div className="bg-white w-full max-w-3xl h-full flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-200">
          <div>
            <div className="text-[10px] font-semibold tracking-wider uppercase text-neutral-400">{isNew ? "New Sample" : "Edit Sample"}</div>
            <div className="font-mono text-sm text-neutral-900">{draft.id || "—"}</div>
          </div>
          <div className="flex items-center gap-2">
            {draft.stage !== undefined && <StatusPill light={statusLight(draft)} />}
            <button onClick={onClose} className="p-1.5 text-neutral-400 hover:text-neutral-700"><X size={18} /></button>
          </div>
        </div>

        <div className="flex px-5 border-b border-neutral-200 shrink-0 overflow-x-auto">
          <DrawerTabBtn active={tab === "overview"} onClick={() => setTab("overview")} icon={ClipboardList}>Overview</DrawerTabBtn>
          <DrawerTabBtn active={tab === "qc"} onClick={() => setTab("qc")} icon={Ruler} count={draft.qc.length}>Measurements</DrawerTabBtn>
          <DrawerTabBtn active={tab === "revisions"} onClick={() => setTab("revisions")} icon={FileStack} count={draft.revisions.length}>Revisions</DrawerTabBtn>
          <DrawerTabBtn active={tab === "comms"} onClick={() => setTab("comms")} icon={MessageSquare} count={draft.comms.length}>Communication</DrawerTabBtn>
          <DrawerTabBtn active={tab === "files"} onClick={() => setTab("files")} icon={Paperclip} count={draft.files.length}>Files</DrawerTabBtn>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {tab === "overview" && (
            <div className="space-y-6">
              <div className="grid grid-cols-3 gap-3">
                <Field label="Sample ID"><TextInput value={draft.id} onChange={(e) => set({ id: e.target.value })} placeholder="OFC-SKU-S1" disabled={!isNew} className={!isNew ? "bg-neutral-100 text-neutral-500" : ""} /></Field>
                <Field label="SKU"><TextInput value={draft.sku} onChange={(e) => set({ sku: e.target.value })} /></Field>
                <Field label="Version"><TextInput value={draft.version} onChange={(e) => set({ version: e.target.value })} /></Field>
                <Field label="Product Name" span><TextInput value={draft.product} onChange={(e) => set({ product: e.target.value })} /></Field>
                <Field label="Category"><Select value={draft.category} onChange={(e) => set({ category: e.target.value })} options={CATEGORY_OPTIONS} /></Field>
                <Field label="Sample Type"><Select value={draft.type} onChange={(e) => set({ type: e.target.value })} options={TYPE_OPTIONS} /></Field>
                <Field label="Manufacturer"><Select value={draft.manufacturer} onChange={(e) => set({ manufacturer: e.target.value })} options={manufacturers.map((m) => m.name)} allowEmpty /></Field>
                <Field label="Manufacturer Contact" span><TextInput value={draft.manufacturerContact} onChange={(e) => set({ manufacturerContact: e.target.value })} /></Field>
                <Field label="Request Date"><TextInput type="date" value={draft.requestDate || ""} onChange={(e) => set({ requestDate: e.target.value })} /></Field>
                <Field label="Target Date"><TextInput type="date" value={draft.targetDate || ""} onChange={(e) => set({ targetDate: e.target.value })} /></Field>
                <Field label="Next Action Due"><TextInput type="date" value={draft.nextDue || ""} onChange={(e) => set({ nextDue: e.target.value })} /></Field>
              </div>

              <div className="grid grid-cols-3 gap-3 pt-4 border-t border-neutral-100">
                <Field label="Fabric / Material" span><TextInput value={draft.fabric} onChange={(e) => set({ fabric: e.target.value })} /></Field>
                <Field label="GSM"><TextInput type="number" value={draft.gsm} onChange={(e) => set({ gsm: e.target.value })} /></Field>
                <Field label="Composition"><TextInput value={draft.composition} onChange={(e) => set({ composition: e.target.value })} /></Field>
                <Field label="Color"><TextInput value={draft.color} onChange={(e) => set({ color: e.target.value })} /></Field>
                <Field label="Size"><Select value={draft.size} onChange={(e) => set({ size: e.target.value })} options={SIZE_OPTIONS} /></Field>
                <Field label="Fit"><Select value={draft.fit} onChange={(e) => set({ fit: e.target.value })} options={FIT_OPTIONS} /></Field>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-4 border-t border-neutral-100">
                <Field label="Tech Pack"><Select value={draft.techPackId} onChange={(e) => set({ techPackId: e.target.value })} options={techPacks.map((t) => t.id)} allowEmpty /></Field>
                <Field label="Reference / Inspiration Link"><TextInput value={draft.refLink} onChange={(e) => set({ refLink: e.target.value })} placeholder="https://drive.google.com/…" /></Field>
                <Field label="Courier / AWB"><TextInput value={draft.courierAwb} onChange={(e) => set({ courierAwb: e.target.value })} /></Field>
                <Field label="Date Sent"><TextInput type="date" value={draft.dateSent || ""} onChange={(e) => set({ dateSent: e.target.value })} /></Field>
                <Field label="Date Received"><TextInput type="date" value={draft.dateReceived || ""} onChange={(e) => set({ dateReceived: e.target.value })} /></Field>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-4 border-t border-neutral-100">
                <Field label="Current Status"><Select value={draft.status} onChange={(e) => set({ status: e.target.value })} options={STATUS_OPTIONS} /></Field>
                <Field label="Current Stage"><Select value={draft.stage} onChange={(e) => set({ stage: e.target.value })} options={STAGE_OPTIONS} /></Field>
                <Field label="Action Owner"><Select value={draft.actionOwner} onChange={(e) => set({ actionOwner: e.target.value })} options={OWNER_OPTIONS} /></Field>
                <Field label="Waiting On"><Select value={draft.waitingOn} onChange={(e) => set({ waitingOn: e.target.value })} options={WAITING_OPTIONS} /></Field>
              </div>

              <div className="grid grid-cols-1 gap-3 pt-4 border-t border-neutral-100">
                <Field label="Manufacturer Update"><TextArea value={draft.mfrUpdate} onChange={(e) => set({ mfrUpdate: e.target.value })} /></Field>
                <Field label="Offcomfrt Feedback"><TextArea value={draft.feedback} onChange={(e) => set({ feedback: e.target.value })} /></Field>
                <Field label="Changes Required"><TextArea value={draft.changesRequired} onChange={(e) => set({ changesRequired: e.target.value })} /></Field>
                <Field label="Next Action"><TextArea value={draft.nextAction} onChange={(e) => set({ nextAction: e.target.value })} /></Field>
              </div>

              <div className="grid grid-cols-3 gap-3 pt-4 border-t border-neutral-100">
                <Field label="Approval Status"><Select value={draft.approvalStatus} onChange={(e) => set({ approvalStatus: e.target.value })} options={APPROVAL_OPTIONS} /></Field>
                <Field label="Approved By"><TextInput value={draft.approvedBy} onChange={(e) => set({ approvedBy: e.target.value })} /></Field>
                <Field label="Approval Date"><TextInput type="date" value={draft.approvalDate || ""} onChange={(e) => set({ approvalDate: e.target.value })} /></Field>
                <Field label="Final Decision" span><TextInput value={draft.finalDecision} onChange={(e) => set({ finalDecision: e.target.value })} /></Field>
                <Field label="Notes" span><TextArea value={draft.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
              </div>

              {draft.approvalStatus === "Approved" && (
                <div className="pt-4 border-t border-neutral-100 flex items-center justify-between bg-emerald-50 -mx-5 px-5 py-3">
                  <div className="text-xs text-emerald-800">This sample is approved. Ready to place a bulk production order with {draft.manufacturer || "the manufacturer"}?</div>
                  <button onClick={() => onPlaceOrder(draft)} className="shrink-0 flex items-center gap-1.5 bg-emerald-700 text-white text-xs font-semibold px-3 py-1.5 rounded-sm hover:bg-emerald-800">
                    <Truck size={13} /> Place Production Order
                  </button>
                </div>
              )}

              <div className="pt-4 border-t border-neutral-100">
                <div className="text-[10px] font-semibold tracking-wider uppercase text-neutral-400 mb-2">Cost Breakdown</div>
                <div className="grid grid-cols-4 gap-3">
                  {["fabricCost", "trims", "cmt", "wash", "labels", "packaging", "courier", "other"].map((k) => (
                    <Field key={k} label={k === "cmt" ? "CMT / Sampling" : k === "wash" ? "Washing / Finish" : k.charAt(0).toUpperCase() + k.slice(1)}>
                      <TextInput type="number" value={draft.cost[k]} onChange={(e) => setCost({ [k]: e.target.value })} />
                    </Field>
                  ))}
                  <Field label="Paid By"><Select value={draft.cost.paidBy} onChange={(e) => setCost({ paidBy: e.target.value })} options={PAID_BY_OPTIONS} /></Field>
                  <Field label="Payment Status"><Select value={draft.cost.paymentStatus} onChange={(e) => setCost({ paymentStatus: e.target.value })} options={PAYMENT_STATUS_OPTIONS} /></Field>
                  <Field label="Invoice / Quote Link" span><TextInput value={draft.cost.invoiceLink} onChange={(e) => setCost({ invoiceLink: e.target.value })} /></Field>
                </div>
                <div className="mt-3 text-sm">Total: <span className="font-mono font-bold">{fmtINR(costTotal(draft.cost))}</span></div>
              </div>
            </div>
          )}

          {tab === "qc" && (
            <div>
              <div className="text-xs text-neutral-400 mb-3">Pass / Fail is calculated automatically from spec vs. tolerance vs. actual measurement.</div>
              <div className="space-y-2">
                {draft.qc.map((row) => {
                  const numeric = row.spec != null && row.spec !== "" && row.tolerance != null && row.tolerance !== "" && row.actual != null && row.actual !== "";
                  const pass = numeric ? Math.abs(Number(row.actual) - Number(row.spec)) <= Number(row.tolerance) : null;
                  return (
                    <div key={row.id} className="border border-neutral-200 rounded-sm p-3 grid grid-cols-12 gap-2 items-center">
                      <TextInput className="col-span-3" placeholder="Measurement point" value={row.point} onChange={(e) => listOp.update("qc", row.id, "point", e.target.value)} />
                      <TextInput className="col-span-2" type="number" placeholder="Spec" value={row.spec ?? ""} onChange={(e) => listOp.update("qc", row.id, "spec", e.target.value)} />
                      <TextInput className="col-span-2" type="number" placeholder="Tolerance" value={row.tolerance ?? ""} onChange={(e) => listOp.update("qc", row.id, "tolerance", e.target.value)} />
                      <TextInput className="col-span-2" type="number" placeholder="Actual" value={row.actual ?? ""} onChange={(e) => listOp.update("qc", row.id, "actual", e.target.value)} />
                      <div className="col-span-2 flex justify-center">
                        {pass == null ? <span className="text-[10px] text-neutral-400">manual</span> :
                          pass ? <span className="text-[11px] font-semibold text-emerald-600">Pass</span> : <span className="text-[11px] font-semibold text-rose-600">Fail</span>}
                      </div>
                      <button onClick={() => listOp.remove("qc", row.id)} className="col-span-1 text-neutral-300 hover:text-rose-600 flex justify-end"><X size={15} /></button>
                      <TextInput className="col-span-6" placeholder="Manufacturer comment" value={row.mfrComment} onChange={(e) => listOp.update("qc", row.id, "mfrComment", e.target.value)} />
                      <TextInput className="col-span-6" placeholder="Offcomfrt comment" value={row.ofcComment} onChange={(e) => listOp.update("qc", row.id, "ofcComment", e.target.value)} />
                    </div>
                  );
                })}
              </div>
              <button onClick={() => listOp.add("qc", { point: "", spec: "", tolerance: "", actual: "", mfrComment: "", ofcComment: "" })}
                className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-neutral-700 hover:text-neutral-900">
                <Plus size={14} /> Add measurement point
              </button>
            </div>
          )}

          {tab === "revisions" && (
            <div className="space-y-3">
              {draft.revisions.map((r) => (
                <div key={r.id} className="border border-neutral-200 rounded-sm p-3 space-y-2">
                  <div className="flex justify-between">
                    <div className="grid grid-cols-4 gap-2 flex-1">
                      <TextInput placeholder="Prev version" value={r.prevVersion} onChange={(e) => listOp.update("revisions", r.id, "prevVersion", e.target.value)} />
                      <TextInput placeholder="New version" value={r.newVersion} onChange={(e) => listOp.update("revisions", r.id, "newVersion", e.target.value)} />
                      <TextInput type="date" value={r.date || ""} onChange={(e) => listOp.update("revisions", r.id, "date", e.target.value)} />
                      <Select value={r.status} onChange={(e) => listOp.update("revisions", r.id, "status", e.target.value)} options={REVISION_STATUS_OPTIONS} />
                    </div>
                    <button onClick={() => listOp.remove("revisions", r.id)} className="ml-2 text-neutral-300 hover:text-rose-600"><X size={15} /></button>
                  </div>
                  <TextArea placeholder="Issue" value={r.issue} onChange={(e) => listOp.update("revisions", r.id, "issue", e.target.value)} />
                  <TextArea placeholder="Root cause" value={r.rootCause} onChange={(e) => listOp.update("revisions", r.id, "rootCause", e.target.value)} />
                  <TextArea placeholder="Change required" value={r.changeRequired} onChange={(e) => listOp.update("revisions", r.id, "changeRequired", e.target.value)} />
                  <TextArea placeholder="Manufacturer response" value={r.mfrResponse} onChange={(e) => listOp.update("revisions", r.id, "mfrResponse", e.target.value)} />
                </div>
              ))}
              <button onClick={() => listOp.add("revisions", { prevVersion: "", newVersion: "", date: todayISO(), issue: "", rootCause: "", changeRequired: "", requestedBy: "", mfrResponse: "", expectedCompletion: "", completedDate: "", status: "Not Started" })}
                className="flex items-center gap-1.5 text-xs font-semibold text-neutral-700 hover:text-neutral-900">
                <Plus size={14} /> Add revision entry
              </button>
            </div>
          )}

          {tab === "comms" && (
            <div className="space-y-3">
              {draft.comms.map((c) => (
                <div key={c.id} className="border border-neutral-200 rounded-sm p-3 space-y-2">
                  <div className="flex justify-between gap-2">
                    <div className="grid grid-cols-4 gap-2 flex-1">
                      <TextInput type="date" value={c.date || ""} onChange={(e) => listOp.update("comms", c.id, "date", e.target.value)} />
                      <TextInput placeholder="From" value={c.from} onChange={(e) => listOp.update("comms", c.id, "from", e.target.value)} />
                      <TextInput placeholder="To" value={c.to} onChange={(e) => listOp.update("comms", c.id, "to", e.target.value)} />
                      <Select value={c.status} onChange={(e) => listOp.update("comms", c.id, "status", e.target.value)} options={COMM_STATUS_OPTIONS} />
                    </div>
                    <button onClick={() => listOp.remove("comms", c.id)} className="text-neutral-300 hover:text-rose-600"><X size={15} /></button>
                  </div>
                  <TextArea placeholder="Message / question" value={c.message} onChange={(e) => listOp.update("comms", c.id, "message", e.target.value)} />
                  <TextArea placeholder="Response" value={c.response} onChange={(e) => listOp.update("comms", c.id, "response", e.target.value)} />
                  <TextArea placeholder="Decision / agreement" value={c.decision} onChange={(e) => listOp.update("comms", c.id, "decision", e.target.value)} />
                </div>
              ))}
              <button onClick={() => listOp.add("comms", { date: todayISO(), from: "", to: "", message: "", response: "", decision: "", actionOwner: "", dueDate: "", status: "Open" })}
                className="flex items-center gap-1.5 text-xs font-semibold text-neutral-700 hover:text-neutral-900">
                <Plus size={14} /> Log a message
              </button>
            </div>
          )}

          {tab === "files" && (
            <div className="space-y-2">
              {draft.files.map((f) => (
                <div key={f.id} className="border border-neutral-200 rounded-sm p-3 grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-3"><Select value={f.type} onChange={(e) => listOp.update("files", f.id, "type", e.target.value)} options={FILE_TYPE_OPTIONS} /></div>
                  <TextInput className="col-span-3" placeholder="Description" value={f.description} onChange={(e) => listOp.update("files", f.id, "description", e.target.value)} />
                  <TextInput className="col-span-4" placeholder="Google Drive link" value={f.link} onChange={(e) => listOp.update("files", f.id, "link", e.target.value)} />
                  <TextInput className="col-span-1" type="date" value={f.date || ""} onChange={(e) => listOp.update("files", f.id, "date", e.target.value)} />
                  <button onClick={() => listOp.remove("files", f.id)} className="col-span-1 flex justify-end text-neutral-300 hover:text-rose-600"><X size={15} /></button>
                </div>
              ))}
              <button onClick={() => listOp.add("files", { type: "Reference Image", description: "", link: "", uploadedBy: "", date: todayISO() })}
                className="flex items-center gap-1.5 text-xs font-semibold text-neutral-700 hover:text-neutral-900">
                <Plus size={14} /> Attach a file link
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t border-neutral-200 shrink-0">
          <div className="text-xs text-rose-500">{idTaken ? `An entry with ID "${draft.id.trim()}" already exists — use a different ID` : (!canSave && "Sample ID, product and manufacturer are required")}</div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm rounded-sm border border-neutral-300 hover:bg-neutral-50">Cancel</button>
            <button disabled={!canSave} onClick={() => onSave(draft)} className="px-4 py-2 text-sm rounded-sm bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-30 disabled:cursor-not-allowed">Save Sample</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================== MANUFACTURERS ============================== */
function ManufacturerModal({ initial, onSave, onClose }) {
  const [draft, setDraft] = useState(initial);
  const set = (p) => setDraft((d) => ({ ...d, ...p }));
  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white w-full max-w-lg rounded-sm border border-neutral-200 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-200">
          <div className="text-sm font-semibold">{initial.name ? "Edit Manufacturer" : "New Manufacturer"}</div>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700"><X size={18} /></button>
        </div>
        <div className="p-5 grid grid-cols-2 gap-3">
          <Field label="Manufacturer Name" span><TextInput value={draft.name} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="Location"><TextInput value={draft.location} onChange={(e) => set({ location: e.target.value })} /></Field>
          <Field label="Contact Person"><TextInput value={draft.contact} onChange={(e) => set({ contact: e.target.value })} /></Field>
          <Field label="Phone"><TextInput value={draft.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
          <Field label="Email"><TextInput value={draft.email} onChange={(e) => set({ email: e.target.value })} /></Field>
          <Field label="Product Categories" span><TextInput value={draft.categories} onChange={(e) => set({ categories: e.target.value })} /></Field>
          <Field label="Fabric Capabilities" span><TextInput value={draft.fabricCapabilities} onChange={(e) => set({ fabricCapabilities: e.target.value })} /></Field>
          <Field label="MOQ"><TextInput value={draft.moq} onChange={(e) => set({ moq: e.target.value })} /></Field>
          <Field label="Sample Lead Time"><TextInput value={draft.sampleLeadTime} onChange={(e) => set({ sampleLeadTime: e.target.value })} /></Field>
          <Field label="Bulk Lead Time"><TextInput value={draft.bulkLeadTime} onChange={(e) => set({ bulkLeadTime: e.target.value })} /></Field>
          <Field label="Quality Rating (1-5)"><TextInput type="number" min="1" max="5" value={draft.qualityRating} onChange={(e) => set({ qualityRating: e.target.value })} /></Field>
          <Field label="Communication Rating (1-5)"><TextInput type="number" min="1" max="5" value={draft.communicationRating} onChange={(e) => set({ communicationRating: e.target.value })} /></Field>
          <Field label="Notes" span><TextArea value={draft.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-neutral-200">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-sm border border-neutral-300 hover:bg-neutral-50">Cancel</button>
          <button disabled={!draft.name.trim()} onClick={() => onSave(draft)} className="px-4 py-2 text-sm rounded-sm bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-30">Save</button>
        </div>
      </div>
    </div>
  );
}

function ManufacturersView({ manufacturers, samples, onNew, onEdit, onDelete }) {
  return (
    <div>
      <div className="flex justify-end mb-4">
        <button onClick={onNew} className="flex items-center gap-1.5 bg-neutral-900 text-white text-sm px-3 py-1.5 rounded-sm hover:bg-neutral-800">
          <Plus size={14} /> New Manufacturer
        </button>
      </div>
      {manufacturers.length === 0 ? (
        <EmptyState icon={Factory} title="No manufacturers yet" hint="Add your first manufacturer to start assigning samples." />
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {manufacturers.map((m) => {
            const ms = samples.filter((s) => s.manufacturer === m.name);
            const completed = ms.filter((s) => s.stage === "Closed");
            const activeN = ms.filter((s) => s.stage !== "Closed").length;
            return (
              <div key={m.id} className="border border-neutral-200 rounded-sm bg-white p-4">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <div className="font-semibold text-sm text-neutral-900">{m.name}</div>
                    <div className="text-xs text-neutral-400">{m.location}</div>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => onEdit(m)} className="p-1 text-neutral-400 hover:text-neutral-800"><Pencil size={13} /></button>
                    <button onClick={() => onDelete(m)} className="p-1 text-neutral-400 hover:text-rose-600"><Trash2 size={13} /></button>
                  </div>
                </div>
                <div className="text-xs text-neutral-500 mb-3">{m.contact} · {m.phone}</div>
                <div className="grid grid-cols-4 gap-2 text-center border-t border-neutral-100 pt-3">
                  <div><div className="text-lg font-mono font-bold">{activeN}</div><div className="text-[9px] uppercase text-neutral-400">Active</div></div>
                  <div><div className="text-lg font-mono font-bold">{completed.length}</div><div className="text-[9px] uppercase text-neutral-400">Completed</div></div>
                  <div><div className="text-lg font-mono font-bold">{m.qualityRating || "—"}</div><div className="text-[9px] uppercase text-neutral-400">Quality</div></div>
                  <div><div className="text-lg font-mono font-bold">{m.communicationRating || "—"}</div><div className="text-[9px] uppercase text-neutral-400">Comms</div></div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================== TECH PACKS ============================== */
function TechPackModal({ initial, onSave, onClose }) {
  const [draft, setDraft] = useState(initial);
  const set = (p) => setDraft((d) => ({ ...d, ...p }));
  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white w-full max-w-lg rounded-sm border border-neutral-200 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-200">
          <div className="text-sm font-semibold">{initial.__isNew ? "New Tech Pack Version" : "Edit Tech Pack"}</div>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700"><X size={18} /></button>
        </div>
        <div className="p-5 grid grid-cols-2 gap-3">
          <Field label="Tech Pack ID"><TextInput value={draft.id} onChange={(e) => set({ id: e.target.value })} placeholder="TP-SKU-V1" /></Field>
          <Field label="SKU"><TextInput value={draft.sku} onChange={(e) => set({ sku: e.target.value })} /></Field>
          <Field label="Product" span><TextInput value={draft.product} onChange={(e) => set({ product: e.target.value })} /></Field>
          <Field label="Version"><TextInput value={draft.version} onChange={(e) => set({ version: e.target.value })} /></Field>
          <Field label="Status"><Select value={draft.status} onChange={(e) => set({ status: e.target.value })} options={TP_STATUS_OPTIONS} /></Field>
          <Field label="Link" span><TextInput value={draft.link} onChange={(e) => set({ link: e.target.value })} /></Field>
          <Field label="Created By"><TextInput value={draft.createdBy} onChange={(e) => set({ createdBy: e.target.value })} /></Field>
          <Field label="Created Date"><TextInput type="date" value={draft.createdDate || ""} onChange={(e) => set({ createdDate: e.target.value })} /></Field>
          <Field label="Manufacturer Questions" span><TextArea value={draft.manufacturerQuestions} onChange={(e) => set({ manufacturerQuestions: e.target.value })} /></Field>
          <Field label="Notes" span><TextArea value={draft.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-neutral-200">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-sm border border-neutral-300 hover:bg-neutral-50">Cancel</button>
          <button disabled={!draft.id.trim()} onClick={() => onSave(draft)} className="px-4 py-2 text-sm rounded-sm bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-30">Save</button>
        </div>
      </div>
    </div>
  );
}

function TechPacksView({ techPacks, onNew, onEdit, onDelete }) {
  const withActive = useMemo(() => {
    const bySku = {};
    techPacks.forEach((t) => { bySku[t.sku] = bySku[t.sku] || []; bySku[t.sku].push(t); });
    Object.values(bySku).forEach((arr) => arr.sort((a, b) => (b.createdDate || "").localeCompare(a.createdDate || "")));
    const activeIds = new Set(Object.values(bySku).map((arr) => arr[0]?.id));
    return techPacks.map((t) => ({ ...t, isActive: activeIds.has(t.id) }));
  }, [techPacks]);

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button onClick={onNew} className="flex items-center gap-1.5 bg-neutral-900 text-white text-sm px-3 py-1.5 rounded-sm hover:bg-neutral-800">
          <Plus size={14} /> New Tech Pack Version
        </button>
      </div>
      {techPacks.length === 0 ? (
        <EmptyState icon={FileStack} title="No tech packs yet" hint="Add a tech pack version to link it from samples." />
      ) : (
        <div className="border border-neutral-200 rounded-sm bg-white overflow-hidden">
          {withActive.map((t) => (
            <div key={t.id} className="flex items-center gap-4 px-4 py-3 border-b last:border-b-0 border-neutral-100 hover:bg-neutral-50">
              <div className="font-mono text-xs text-neutral-500 w-44 truncate">{t.id}</div>
              <div className="w-56 text-sm text-neutral-800 truncate">{t.product}</div>
              <div className="w-36 text-xs text-neutral-600">{t.status}</div>
              <div className="w-24 font-mono text-xs text-neutral-500">{fmtDate(t.createdDate)}</div>
              <div className="w-24">
                {t.isActive ? <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-sm">● ACTIVE</span>
                  : <span className="text-[10px] text-neutral-400">Superseded</span>}
              </div>
              <a href={t.link} target="_blank" rel="noreferrer" className="text-neutral-400 hover:text-neutral-800"><ExternalLink size={13} /></a>
              <div className="flex-1" />
              <button onClick={() => onEdit(t)} className="p-1 text-neutral-400 hover:text-neutral-800"><Pencil size={13} /></button>
              <button onClick={() => onDelete(t)} className="p-1 text-neutral-400 hover:text-rose-600"><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================== PRODUCTION ============================== */
function StageStepper({ stage }) {
  const idx = PROD_STAGE_OPTIONS.indexOf(stage);
  return (
    <div className="flex items-center overflow-x-auto pb-1">
      {PROD_STAGE_OPTIONS.map((s, i) => (
        <div key={s} className="flex items-center shrink-0">
          <div className="flex flex-col items-center gap-1">
            <div className={`w-2.5 h-2.5 rounded-full ${i < idx ? "bg-neutral-900" : i === idx ? "bg-emerald-500" : "bg-neutral-200"}`} />
            <div className={`text-[9px] whitespace-nowrap ${i === idx ? "font-bold text-neutral-900" : "text-neutral-400"}`}>{s}</div>
          </div>
          {i < PROD_STAGE_OPTIONS.length - 1 && <div className={`w-8 h-px mb-4 ${i < idx ? "bg-neutral-900" : "bg-neutral-200"}`} />}
        </div>
      ))}
    </div>
  );
}

function ProductionDrawer({ initial, isNew, manufacturers, samples, existingIds, onSave, onClose }) {
  const [draft, setDraft] = useState(initial);
  const [tab, setTab] = useState("overview");
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const listOp = {
    add: (key, blank) => setDraft((d) => ({ ...d, [key]: [...d[key], { id: uid(key.toUpperCase()), ...blank }] })),
    update: (key, id, field, value) => setDraft((d) => ({ ...d, [key]: d[key].map((it) => it.id === id ? { ...it, [field]: value } : it) })),
    remove: (key, id) => setDraft((d) => ({ ...d, [key]: d[key].filter((it) => it.id !== id) })),
  };
  const approvedSamples = samples.filter((s) => s.approvalStatus === "Approved");
  const idTaken = isNew && (existingIds || []).includes(draft.id.trim());
  const canSave = draft.id.trim() && draft.product.trim() && draft.manufacturer.trim() && !idTaken;
  const qty = orderQty(draft);
  const value = orderValue(draft);
  const balance = orderBalance(draft);

  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex justify-end">
      <div className="bg-white w-full max-w-3xl h-full flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-200">
          <div>
            <div className="text-[10px] font-semibold tracking-wider uppercase text-neutral-400">{isNew ? "New Production Order" : "Edit Production Order"}</div>
            <div className="font-mono text-sm text-neutral-900">{draft.id || "—"}</div>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill light={productionLight(draft)} />
            <button onClick={onClose} className="p-1.5 text-neutral-400 hover:text-neutral-700"><X size={18} /></button>
          </div>
        </div>

        <div className="px-5 py-3 border-b border-neutral-200 bg-neutral-50">
          <StageStepper stage={draft.currentStage} />
        </div>

        <div className="flex px-5 border-b border-neutral-200 shrink-0 overflow-x-auto">
          <DrawerTabBtn active={tab === "overview"} onClick={() => setTab("overview")} icon={ClipboardList}>Overview</DrawerTabBtn>
          <DrawerTabBtn active={tab === "qc"} onClick={() => setTab("qc")} icon={Ruler} count={draft.qc.length}>QC Checkpoints</DrawerTabBtn>
          <DrawerTabBtn active={tab === "comms"} onClick={() => setTab("comms")} icon={MessageSquare} count={draft.comms.length}>Communication</DrawerTabBtn>
          <DrawerTabBtn active={tab === "files"} onClick={() => setTab("files")} icon={Paperclip} count={draft.files.length}>Files</DrawerTabBtn>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {tab === "overview" && (
            <div className="space-y-6">
              <div className="grid grid-cols-3 gap-3">
                <Field label="Order ID"><TextInput value={draft.id} onChange={(e) => set({ id: e.target.value })} placeholder="PO-SKU-B1" disabled={!isNew} className={!isNew ? "bg-neutral-100 text-neutral-500" : ""} /></Field>
                <Field label="Linked Sample"><Select value={draft.sampleId} onChange={(e) => { const s = samples.find((x) => x.id === e.target.value); set({ sampleId: e.target.value, ...(s ? { product: s.product, sku: s.sku, category: s.category, manufacturer: s.manufacturer, manufacturerContact: s.manufacturerContact } : {}) }); }} options={approvedSamples.map((s) => s.id)} allowEmpty /></Field>
                <Field label="SKU"><TextInput value={draft.sku} onChange={(e) => set({ sku: e.target.value })} /></Field>
                <Field label="Product Name" span><TextInput value={draft.product} onChange={(e) => set({ product: e.target.value })} /></Field>
                <Field label="Category"><Select value={draft.category} onChange={(e) => set({ category: e.target.value })} options={CATEGORY_OPTIONS} /></Field>
                <Field label="Manufacturer"><Select value={draft.manufacturer} onChange={(e) => set({ manufacturer: e.target.value })} options={manufacturers.map((m) => m.name)} allowEmpty /></Field>
                <Field label="Manufacturer Contact" span><TextInput value={draft.manufacturerContact} onChange={(e) => set({ manufacturerContact: e.target.value })} /></Field>
                <Field label="PO Date"><TextInput type="date" value={draft.poDate || ""} onChange={(e) => set({ poDate: e.target.value })} /></Field>
                <Field label="Expected Delivery"><TextInput type="date" value={draft.expectedDelivery || ""} onChange={(e) => set({ expectedDelivery: e.target.value })} /></Field>
                <Field label="Actual Delivery"><TextInput type="date" value={draft.actualDelivery || ""} onChange={(e) => set({ actualDelivery: e.target.value })} /></Field>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-4 border-t border-neutral-100">
                <Field label="Current Stage"><Select value={draft.currentStage} onChange={(e) => set({ currentStage: e.target.value })} options={PROD_STAGE_OPTIONS} /></Field>
                <Field label="Action Owner"><Select value={draft.actionOwner} onChange={(e) => set({ actionOwner: e.target.value })} options={OWNER_OPTIONS} /></Field>
                <Field label="Waiting On"><Select value={draft.waitingOn} onChange={(e) => set({ waitingOn: e.target.value })} options={WAITING_OPTIONS} /></Field>
                <Field label="Next Action Due"><TextInput type="date" value={draft.nextActionDue || ""} onChange={(e) => set({ nextActionDue: e.target.value })} /></Field>
                <Field label="Next Action" span><TextArea value={draft.nextAction} onChange={(e) => set({ nextAction: e.target.value })} /></Field>
              </div>

              <div className="pt-4 border-t border-neutral-100">
                <div className="text-[10px] font-semibold tracking-wider uppercase text-neutral-400 mb-2">Quantity Breakdown</div>
                <div className="space-y-2">
                  {draft.breakdown.map((r) => (
                    <div key={r.id} className="grid grid-cols-12 gap-2 items-center">
                      <div className="col-span-4"><Select value={r.size} onChange={(e) => listOp.update("breakdown", r.id, "size", e.target.value)} options={SIZE_OPTIONS} /></div>
                      <TextInput className="col-span-4" placeholder="Colour" value={r.color} onChange={(e) => listOp.update("breakdown", r.id, "color", e.target.value)} />
                      <TextInput className="col-span-3" type="number" placeholder="Qty" value={r.qty} onChange={(e) => listOp.update("breakdown", r.id, "qty", e.target.value)} />
                      <button onClick={() => listOp.remove("breakdown", r.id)} className="col-span-1 flex justify-end text-neutral-300 hover:text-rose-600"><X size={15} /></button>
                    </div>
                  ))}
                </div>
                <button onClick={() => listOp.add("breakdown", { size: "M", color: "", qty: 0 })}
                  className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-neutral-700 hover:text-neutral-900">
                  <Plus size={14} /> Add size/colour row
                </button>
                <div className="mt-3 text-sm">Total Quantity: <span className="font-mono font-bold">{qty.toLocaleString("en-IN")}</span> pcs</div>
              </div>

              <div className="pt-4 border-t border-neutral-100">
                <div className="text-[10px] font-semibold tracking-wider uppercase text-neutral-400 mb-2">Pricing & Payment</div>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Unit Price"><TextInput type="number" value={draft.unitPrice} onChange={(e) => set({ unitPrice: e.target.value })} /></Field>
                  <Field label="Advance Paid"><TextInput type="number" value={draft.advancePaid} onChange={(e) => set({ advancePaid: e.target.value })} /></Field>
                  <Field label="Payment Status"><Select value={draft.paymentStatus} onChange={(e) => set({ paymentStatus: e.target.value })} options={PROD_PAYMENT_OPTIONS} /></Field>
                </div>
                <div className="mt-3 flex gap-6 text-sm">
                  <div>Order Value: <span className="font-mono font-bold">{fmtINR(value)}</span></div>
                  <div>Balance Due: <span className="font-mono font-bold">{fmtINR(balance)}</span></div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-4 border-t border-neutral-100">
                <Field label="Shipping Method"><TextInput value={draft.shippingMethod} onChange={(e) => set({ shippingMethod: e.target.value })} /></Field>
                <Field label="Tracking Number"><TextInput value={draft.trackingNumber} onChange={(e) => set({ trackingNumber: e.target.value })} /></Field>
                <Field label="Notes" span><TextArea value={draft.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
              </div>
            </div>
          )}

          {tab === "qc" && (
            <div>
              <div className="text-xs text-neutral-400 mb-3">Log inline, pre-final, and final random inspections for this order.</div>
              <div className="space-y-3">
                {draft.qc.map((row) => (
                  <div key={row.id} className="border border-neutral-200 rounded-sm p-3 space-y-2">
                    <div className="grid grid-cols-4 gap-2">
                      <Select value={row.checkpoint} onChange={(e) => listOp.update("qc", row.id, "checkpoint", e.target.value)} options={PROD_QC_CHECKPOINTS} />
                      <TextInput type="date" value={row.date || ""} onChange={(e) => listOp.update("qc", row.id, "date", e.target.value)} />
                      <TextInput placeholder="Inspector" value={row.inspector} onChange={(e) => listOp.update("qc", row.id, "inspector", e.target.value)} />
                      <Select value={row.result} onChange={(e) => listOp.update("qc", row.id, "result", e.target.value)} options={PROD_QC_RESULT_OPTIONS} />
                    </div>
                    <div className="flex gap-2 items-start">
                      <TextInput className="w-32" type="number" placeholder="Defect %" value={row.defectRate} onChange={(e) => listOp.update("qc", row.id, "defectRate", e.target.value)} />
                      <TextArea className="flex-1" placeholder="Comments" value={row.comments} onChange={(e) => listOp.update("qc", row.id, "comments", e.target.value)} />
                      <button onClick={() => listOp.remove("qc", row.id)} className="text-neutral-300 hover:text-rose-600 mt-1.5"><X size={15} /></button>
                    </div>
                  </div>
                ))}
              </div>
              <button onClick={() => listOp.add("qc", { checkpoint: "Inline Inspection", date: todayISO(), inspector: "", result: "Pending", defectRate: "", comments: "" })}
                className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-neutral-700 hover:text-neutral-900">
                <Plus size={14} /> Log an inspection
              </button>
            </div>
          )}

          {tab === "comms" && (
            <div className="space-y-3">
              {draft.comms.map((c) => (
                <div key={c.id} className="border border-neutral-200 rounded-sm p-3 space-y-2">
                  <div className="flex justify-between gap-2">
                    <div className="grid grid-cols-4 gap-2 flex-1">
                      <TextInput type="date" value={c.date || ""} onChange={(e) => listOp.update("comms", c.id, "date", e.target.value)} />
                      <TextInput placeholder="From" value={c.from} onChange={(e) => listOp.update("comms", c.id, "from", e.target.value)} />
                      <TextInput placeholder="To" value={c.to} onChange={(e) => listOp.update("comms", c.id, "to", e.target.value)} />
                      <Select value={c.status} onChange={(e) => listOp.update("comms", c.id, "status", e.target.value)} options={COMM_STATUS_OPTIONS} />
                    </div>
                    <button onClick={() => listOp.remove("comms", c.id)} className="text-neutral-300 hover:text-rose-600"><X size={15} /></button>
                  </div>
                  <TextArea placeholder="Message / question" value={c.message} onChange={(e) => listOp.update("comms", c.id, "message", e.target.value)} />
                  <TextArea placeholder="Response" value={c.response} onChange={(e) => listOp.update("comms", c.id, "response", e.target.value)} />
                  <TextArea placeholder="Decision / agreement" value={c.decision} onChange={(e) => listOp.update("comms", c.id, "decision", e.target.value)} />
                </div>
              ))}
              <button onClick={() => listOp.add("comms", { date: todayISO(), from: "", to: "", message: "", response: "", decision: "", actionOwner: "", dueDate: "", status: "Open" })}
                className="flex items-center gap-1.5 text-xs font-semibold text-neutral-700 hover:text-neutral-900">
                <Plus size={14} /> Log a message
              </button>
            </div>
          )}

          {tab === "files" && (
            <div className="space-y-2">
              {draft.files.map((f) => (
                <div key={f.id} className="border border-neutral-200 rounded-sm p-3 grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-3"><Select value={f.type} onChange={(e) => listOp.update("files", f.id, "type", e.target.value)} options={PROD_FILE_TYPE_OPTIONS} /></div>
                  <TextInput className="col-span-3" placeholder="Description" value={f.description} onChange={(e) => listOp.update("files", f.id, "description", e.target.value)} />
                  <TextInput className="col-span-4" placeholder="Google Drive link" value={f.link} onChange={(e) => listOp.update("files", f.id, "link", e.target.value)} />
                  <TextInput className="col-span-1" type="date" value={f.date || ""} onChange={(e) => listOp.update("files", f.id, "date", e.target.value)} />
                  <button onClick={() => listOp.remove("files", f.id)} className="col-span-1 flex justify-end text-neutral-300 hover:text-rose-600"><X size={15} /></button>
                </div>
              ))}
              <button onClick={() => listOp.add("files", { type: "Purchase Order", description: "", link: "", uploadedBy: "", date: todayISO() })}
                className="flex items-center gap-1.5 text-xs font-semibold text-neutral-700 hover:text-neutral-900">
                <Plus size={14} /> Attach a file link
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t border-neutral-200 shrink-0">
          <div className="text-xs text-rose-500">{idTaken ? `An order with ID "${draft.id.trim()}" already exists — use a different ID` : (!canSave && "Order ID, product and manufacturer are required")}</div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm rounded-sm border border-neutral-300 hover:bg-neutral-50">Cancel</button>
            <button disabled={!canSave} onClick={() => onSave(draft)} className="px-4 py-2 text-sm rounded-sm bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-30 disabled:cursor-not-allowed">Save Order</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProductionView({ orders, manufacturers, onOpen, onNew, onDelete }) {
  const [fMfr, setFMfr] = useState("All");
  const [fStage, setFStage] = useState("All");

  const filtered = orders.filter((o) =>
    (fMfr === "All" || o.manufacturer === fMfr) && (fStage === "All" || o.currentStage === fStage)
  ).sort((a, b) => {
    const order = { red: 0, yellow: 1, green: 2, grey: 3 };
    return order[productionLight(a)] - order[productionLight(b)];
  });

  const totalValue = orders.reduce((a, o) => a + orderValue(o), 0);
  const totalBalance = orders.reduce((a, o) => a + orderBalance(o), 0);
  const inProduction = orders.filter((o) => o.currentStage !== "Delivered").length;
  const delayed = orders.filter((o) => productionLight(o) === "red").length;

  return (
    <div>
      <div className="grid grid-cols-5 border border-neutral-200 rounded-sm bg-white divide-x divide-neutral-200 mb-5">
        <KpiCard label="Total Orders" value={orders.length} />
        <KpiCard label="In Production" value={inProduction} />
        <KpiCard label="Delayed" value={delayed} accent={delayed ? "text-rose-600" : undefined} />
        <KpiCard label="Total Order Value" value={fmtINR(totalValue)} />
        <KpiCard label="Balance Due" value={fmtINR(totalBalance)} />
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select value={fMfr} onChange={(e) => setFMfr(e.target.value)} className="border border-neutral-300 rounded-sm px-2 py-1.5 text-xs bg-white">
          <option>All</option>{manufacturers.map((m) => <option key={m.id}>{m.name}</option>)}
        </select>
        <select value={fStage} onChange={(e) => setFStage(e.target.value)} className="border border-neutral-300 rounded-sm px-2 py-1.5 text-xs bg-white">
          <option>All</option>{PROD_STAGE_OPTIONS.map((s) => <option key={s}>{s}</option>)}
        </select>
        <button onClick={onNew} className="ml-auto flex items-center gap-1.5 bg-neutral-900 text-white text-sm px-3 py-1.5 rounded-sm hover:bg-neutral-800">
          <Plus size={14} /> New Production Order
        </button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Truck} title="No production orders yet" hint="Approve a sample, then place your first bulk order — or add one directly here."
          action={<button onClick={onNew} className="mt-3 text-xs font-semibold text-neutral-900 underline">+ New production order</button>} />
      ) : (
        <div className="border border-neutral-200 rounded-sm bg-white overflow-hidden">
          {filtered.map((o) => {
            const light = productionLight(o);
            return (
              <div key={o.id} className="flex items-stretch border-b last:border-b-0 border-neutral-100 hover:bg-neutral-50 group">
                <div className={`w-1 ${LIGHT_DOT[light]} shrink-0`} />
                <button onClick={() => onOpen(o)} className="flex-1 flex items-center gap-4 px-4 py-3 text-left min-w-0">
                  <div className="w-36 shrink-0 font-mono text-[11px] text-neutral-500 truncate">{o.id}</div>
                  <div className="w-52 shrink-0 min-w-0">
                    <div className="text-sm text-neutral-900 truncate">{o.product}</div>
                    <div className="text-[11px] text-neutral-400">{orderQty(o).toLocaleString("en-IN")} pcs</div>
                  </div>
                  <div className="w-40 shrink-0 text-xs text-neutral-600 truncate">{o.manufacturer}</div>
                  <div className="w-32 shrink-0 text-xs text-neutral-600">{o.currentStage}</div>
                  <div className="w-24 shrink-0 text-xs font-mono text-neutral-500">{fmtDate(o.expectedDelivery)}</div>
                  <div className="w-24 shrink-0 text-xs font-mono text-neutral-700">{fmtINR(orderValue(o))}</div>
                  <div className="w-24 shrink-0"><StatusPill light={light} /></div>
                </button>
                <button onClick={() => onDelete(o)} className="px-3 opacity-0 group-hover:opacity-100 text-neutral-300 hover:text-rose-600 transition-opacity">
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================== APP ============================== */
export default function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("dashboard");
  const [drawerSample, setDrawerSample] = useState(null);
  const [drawerIsNew, setDrawerIsNew] = useState(false);
  const [prodDrawer, setProdDrawer] = useState(null);
  const [prodDrawerIsNew, setProdDrawerIsNew] = useState(false);
  const [mfrModal, setMfrModal] = useState(null);
  const [tpModal, setTpModal] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [toast, setToast] = useState(null);

  const showToast = (msg, kind = "ok") => { setToast({ msg, kind }); setTimeout(() => setToast(null), 2600); };

  useEffect(() => {
    (async () => {
      let loaded = null;
      try {
        const res = await window.storage.get(STORAGE_KEY, true);
        if (res && res.value) loaded = JSON.parse(res.value);
      } catch (e) { /* key not found or storage unavailable */ }
      if (!loaded) {
        loaded = seedWorkspace();
        try { await window.storage.set(STORAGE_KEY, JSON.stringify(loaded), true); } catch (e) { /* ignore */ }
      }
      loaded.productionOrders = loaded.productionOrders || [];
      loaded.samples = loaded.samples || [];
      loaded.manufacturers = loaded.manufacturers || [];
      loaded.techPacks = loaded.techPacks || [];
      setData(loaded);
      setLoading(false);
    })();
  }, []);

  const persist = useCallback(async (next) => {
    setData(next);
    setSaving(true);
    try {
      const ok = await window.storage.set(STORAGE_KEY, JSON.stringify({ ...next, updatedAt: new Date().toISOString() }), true);
      if (!ok) showToast("Save may not have synced — check connection", "error");
    } catch (e) {
      showToast("Couldn't save changes", "error");
    } finally {
      setSaving(false);
    }
  }, []);

  if (loading || !data) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center">
        <div className="flex items-center gap-2 text-neutral-400 text-sm">
          <Loader2 size={16} className="animate-spin" /> Loading workspace…
        </div>
      </div>
    );
  }

  const NAV = [
    { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { key: "samples", label: "Samples", icon: Package },
    { key: "production", label: "Production", icon: Truck },
    { key: "manufacturers", label: "Manufacturers", icon: Factory },
    { key: "techpacks", label: "Tech Packs", icon: FileStack },
  ];

  return (
    <div className="min-h-screen bg-stone-50 text-neutral-900" style={{ fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif" }}>
      <div className="bg-neutral-900 text-white">
        <div className="max-w-[1400px] mx-auto px-6 pt-6 pb-4">
          <div className="flex items-baseline justify-between">
            <div>
              <div className="text-2xl font-black tracking-tight">OFFCOMFRT</div>
              <div className="text-[11px] font-semibold tracking-[0.15em] text-neutral-400 uppercase mt-0.5">Product Development Control Tower</div>
            </div>
            <div className="text-[10px] text-neutral-500 flex items-center gap-1.5">
              {saving ? <><Loader2 size={11} className="animate-spin" /> Saving…</> : <>Shared workspace · live for everyone with this link</>}
            </div>
          </div>
        </div>
        <div className="max-w-[1400px] mx-auto px-6 flex gap-1">
          {NAV.map((n) => (
            <button key={n.key} onClick={() => setTab(n.key)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-semibold border-b-2 -mb-px transition-colors ${tab === n.key ? "border-white text-white" : "border-transparent text-neutral-400 hover:text-neutral-200"}`}>
              <n.icon size={13} /> {n.label}
            </button>
          ))}
        </div>
      </div>

      <main className="max-w-[1400px] mx-auto px-6 py-6">
        {tab === "dashboard" && (
          <Dashboard
            samples={data.samples}
            manufacturers={data.manufacturers}
            productionOrders={data.productionOrders}
            onOpenSample={(s) => { setDrawerIsNew(false); setDrawerSample(s); }}
            onOpenOrder={(o) => { setProdDrawerIsNew(false); setProdDrawer(o); }}
          />
        )}
        {tab === "samples" && (
          <SamplesTable
            samples={data.samples}
            manufacturers={data.manufacturers}
            onOpen={(s) => { setDrawerIsNew(false); setDrawerSample(s); }}
            onNew={() => { setDrawerIsNew(true); setDrawerSample(emptySample()); }}
            onDelete={(s) => setConfirm({ type: "sample", item: s, title: "Delete this sample?", message: `${s.id} — ${s.product} will be permanently removed.` })}
          />
        )}
        {tab === "production" && (
          <ProductionView
            orders={data.productionOrders}
            manufacturers={data.manufacturers}
            onOpen={(o) => { setProdDrawerIsNew(false); setProdDrawer(o); }}
            onNew={() => { setProdDrawerIsNew(true); setProdDrawer(emptyProductionOrder()); }}
            onDelete={(o) => setConfirm({ type: "production", item: o, title: "Delete this production order?", message: `${o.id} — ${o.product} will be permanently removed.` })}
          />
        )}
        {tab === "manufacturers" && (
          <ManufacturersView
            manufacturers={data.manufacturers}
            samples={data.samples}
            onNew={() => setMfrModal({ id: uid("MFR"), name: "", location: "", contact: "", phone: "", email: "", categories: "", fabricCapabilities: "", moq: "", sampleLeadTime: "", bulkLeadTime: "", qualityRating: "", communicationRating: "", notes: "" })}
            onEdit={(m) => setMfrModal(m)}
            onDelete={(m) => setConfirm({ type: "manufacturer", item: m, title: "Delete this manufacturer?", message: `${m.name} will be removed. Samples already assigned to them will keep the name as text.` })}
          />
        )}
        {tab === "techpacks" && (
          <TechPacksView
            techPacks={data.techPacks}
            onNew={() => setTpModal({ __isNew: true, id: "", sku: "", product: "", version: "V1", status: "Draft", link: "", createdBy: "Offcomfrt Product", createdDate: todayISO(), sentToManufacturer: false, manufacturerAcknowledged: false, manufacturerQuestions: "", revisionRequired: false, finalApproved: false, approvedDate: "", notes: "" })}
            onEdit={(t) => setTpModal(t)}
            onDelete={(t) => setConfirm({ type: "techpack", item: t, title: "Delete this tech pack version?", message: `${t.id} will be permanently removed.` })}
          />
        )}
      </main>

      {drawerSample && (
        <SampleDrawer
          initial={drawerSample}
          isNew={drawerIsNew}
          manufacturers={data.manufacturers}
          techPacks={data.techPacks}
          existingIds={data.samples.map((s) => s.id)}
          onClose={() => setDrawerSample(null)}
          onSave={(draft) => {
            const exists = data.samples.some((s) => s.id === draft.id);
            const samples = exists ? data.samples.map((s) => s.id === draft.id ? draft : s) : [...data.samples, draft];
            persist({ ...data, samples });
            showToast(exists ? "Sample updated" : "Sample added");
            setDrawerSample(null);
          }}
          onPlaceOrder={(sample) => {
            const blank = emptyProductionOrder();
            const skuSlug = (sample.sku || sample.id).replace(/[^A-Z0-9]/gi, "").toUpperCase();
            const existingNums = data.productionOrders
              .filter((o) => o.id.startsWith(`PO-${skuSlug}-B`))
              .map((o) => parseInt(o.id.split("-B").pop(), 10))
              .filter((n) => !isNaN(n));
            const nextNum = existingNums.length ? Math.max(...existingNums) + 1 : 1;
            setProdDrawerIsNew(true);
            setProdDrawer({
              ...blank,
              id: `PO-${skuSlug}-B${nextNum}`,
              sampleId: sample.id, sku: sample.sku, product: sample.product, category: sample.category,
              manufacturer: sample.manufacturer, manufacturerContact: sample.manufacturerContact,
            });
            setDrawerSample(null);
            setTab("production");
          }}
        />
      )}

      {prodDrawer && (
        <ProductionDrawer
          initial={prodDrawer}
          isNew={prodDrawerIsNew}
          manufacturers={data.manufacturers}
          samples={data.samples}
          existingIds={data.productionOrders.map((o) => o.id)}
          onClose={() => setProdDrawer(null)}
          onSave={(draft) => {
            const exists = data.productionOrders.some((o) => o.id === draft.id);
            const productionOrders = exists ? data.productionOrders.map((o) => o.id === draft.id ? draft : o) : [...data.productionOrders, draft];
            persist({ ...data, productionOrders });
            showToast(exists ? "Production order updated" : "Production order placed");
            setProdDrawer(null);
          }}
        />
      )}

      {mfrModal && (
        <ManufacturerModal
          initial={mfrModal}
          onClose={() => setMfrModal(null)}
          onSave={(draft) => {
            const exists = data.manufacturers.some((m) => m.id === draft.id);
            const manufacturers = exists ? data.manufacturers.map((m) => m.id === draft.id ? draft : m) : [...data.manufacturers, draft];
            persist({ ...data, manufacturers });
            showToast(exists ? "Manufacturer updated" : "Manufacturer added");
            setMfrModal(null);
          }}
        />
      )}

      {tpModal && (
        <TechPackModal
          initial={tpModal}
          onClose={() => setTpModal(null)}
          onSave={(draft) => {
            const exists = data.techPacks.some((t) => t.id === draft.id);
            const techPacks = exists ? data.techPacks.map((t) => t.id === draft.id ? draft : t) : [...data.techPacks, draft];
            persist({ ...data, techPacks });
            showToast(exists ? "Tech pack updated" : "Tech pack added");
            setTpModal(null);
          }}
        />
      )}

      <ConfirmDialog
        data={confirm}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm.type === "sample") persist({ ...data, samples: data.samples.filter((s) => s.id !== confirm.item.id) });
          if (confirm.type === "production") persist({ ...data, productionOrders: data.productionOrders.filter((o) => o.id !== confirm.item.id) });
          if (confirm.type === "manufacturer") persist({ ...data, manufacturers: data.manufacturers.filter((m) => m.id !== confirm.item.id) });
          if (confirm.type === "techpack") persist({ ...data, techPacks: data.techPacks.filter((t) => t.id !== confirm.item.id) });
          showToast("Deleted");
          setConfirm(null);
        }}
      />

      <Toast toast={toast} />
    </div>
  );
}
