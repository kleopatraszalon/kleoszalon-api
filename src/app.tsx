// src/app.tsx
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import AppointmentsList from "./pages/AppointmentsList";
import AppointmentsCalendar from "./pages/AppointmentsCalendar"; // <-- legyen exportálva
import EmployeesList from "./pages/EmployeesList";


const WorkOrdersList = lazy(() => import("./pages/WorkOrdersList"));
const WorkOrderNew   = lazy(() => import("./pages/WorkOrderNew"));
const WorkOrderView  = lazy(() => import("./pages/WorkOrderView"));

<Route path="/workorders/list" element={<RequireAuth><WorkOrdersList/></RequireAuth>} />
<Route path="/workorders/new"  element={<RequireAuth><WorkOrderNew/></RequireAuth>} />
<Route path="/workorders/:id"  element={<RequireAuth><WorkOrderView/></RequireAuth>} />

// Aliasok a meglévő DB menükhöz
<Route path="/workorders/add-items" element={<RequireAuth><WorkOrdersList/></RequireAuth>} />
<Route path="/workorders/payment"   element={<RequireAuth><WorkOrdersList/></RequireAuth>} />
<Route path="/workorders/close"     element={<RequireAuth><WorkOrdersList/></RequireAuth>} />

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home/>} />
        <Route path="/appointments" element={<AppointmentsList/>} />
        <Route path="/appointments/calendar" element={<AppointmentsCalendar/>} />
        <Route path="/employees" element={<EmployeesList/>} />
        {/* ide jöhetnek a többiek */}
      </Routes>
    </BrowserRouter>
  );
}
