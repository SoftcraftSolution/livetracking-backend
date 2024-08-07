const http = require('http');
const express = require('express');
const socketIo = require('socket.io');
const mongoose = require('mongoose');

// Import the necessary models
const Driver = require('./src/model/driver.model');
const PatientRequest = require('./src/model/patientrequest.model');
const Salesman=require('./src/model/salesman.model')

// Load environment variables from .env file
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware to parse JSON bodies
app.use(express.json());

let driverSockets = new Map(); // Map to store driver's socket connections by phoneNumber
let clientSockets = new Map();
let salesmanSockets = new Map(); // Map to store client's socket connections by phoneNumber

// Function to calculate distance between two locations (Haversine formula)
function getDistance(loc1, loc2) {
  
  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371; // Radius of the Earth in kilometers

  const dLat = toRad(parseFloat(loc2.latitude) - parseFloat(loc1["latitude"]));
  const dLon = toRad(parseFloat(loc2.longitude )- parseFloat(loc1["longitude"]));
  const lat1 = toRad(parseFloat(loc1["latitude"]));
  const lat2 = toRad(parseFloat(loc2.latitude));

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in kilometers
}

// Function to find the nearest active driver
// Function to find the nearest active driver
async function findNearestDriver(pickupLocation, excludedDriverNumbers = []) {
  console.log("in findNearestDriver()");

  try {
    let nearestDriver = null;
    let shortestDistance = Infinity;

    const activeDrivers = await Driver.find({ isActive: true, phoneNumber: { $nin: excludedDriverNumbers } });

    console.log(`Active drivers count: ${activeDrivers.length}`);
    if (activeDrivers.length === 0) {
      console.log('No active drivers available');
      return { nearestDriver: null, shortestDistance: Infinity };
    }

    for (const driver of activeDrivers) {
      const distance = getDistance(pickupLocation, driver);
      console.log(`Distance to driver ${driver.phoneNumber}: ${distance} km`);

      if (distance < shortestDistance) {
        shortestDistance = distance;
        nearestDriver = driver;
      }
    }

    console.log("end of the findNearestDriver()");
    if (nearestDriver) {
      console.log(`Nearest driver found: ${nearestDriver.phoneNumber} at distance ${shortestDistance} km`);
    } else {
      console.log('No nearest driver found');
    }

    return { nearestDriver, shortestDistance };
  } catch (error) {
    console.error('Error in findNearestDriver:', error);
    return { nearestDriver: null, shortestDistance: Infinity };
  }
}



// Connect to MongoDB
mongoose.connect("mongodb+srv://Rahul:myuser@rahul.fack9.mongodb.net/Databaserahul?authSource=admin&replicaSet=atlas-117kuv-shard-0&w=majority&readPreference=primary&retryWrites=true&ssl=true")
  .then(() => {
    console.log('Connected to MongoDB');
  })
  .catch((err) => {
    console.error('Error connecting to MongoDB:', err);
  });

// Socket.io connection event handler
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('registerDriver', async (phoneNumber) => {
    console.log(typeof phoneNumber);
    const driver = await Driver.findOne({ phoneNumber });
    if (driver) {
      driverSockets.set(phoneNumber, socket);
      
      console.log("=============verify=============");
      console.log(driverSockets.size);
      console.log('Driver registered:', phoneNumber);
    } else {
      console.log('Driver not found for phone number:', phoneNumber);
    }
  });

  socket.on('registerClient', (phoneNumber) => {
    console.log(phoneNumber);
    clientSockets.set(phoneNumber, socket);
    console.log('Client registered:', phoneNumber);
  });

  // Handle driver response to request
  socket.on('requestAccepted', async (data) => {
    console.log("in requestAccepted event =================");
    console.log(data);
    console.log("this is the type of the data");
    console.log(typeof data);
    const driver = await Driver.findOne({ phoneNumber: data.driverPhoneNumber });

    console.log("after finding the data from db =================");

    console.log(driver);
    if (driver) {
      driver.isActive = false;
      await driver.save();
      const request = await PatientRequest.findOne({ requestId: data.requestId });

      if (request) {
        // Update the patient request with the ride status, driver number, and driver name
        request.rideStatus = 'accepted';
        request.driverPhoneNumber = driver.phoneNumber;
        request.driverName = `${driver.firstName} ${driver.lastName}`;
        request.rating=driver.rating;
        await request.save();
        console.log("Driver information saved successfully");

        const clientSocket = clientSockets.get(Number(request.patientPhoneNumber));
        if (clientSocket) {
          // Emit the updated request details to the client
          clientSocket.emit('requestAccepted', request
          );
        }
        console.log(`Driver ${data.driverId} accepted request ${data.requestId}`);
      }
    }
  });

  // Handle driver denying the request
  socket.on('requestDenied', async (data) => {
    console.log(`Driver ${data.driverPhoneNumber} denied request ${data.requestId}`);
    const deniedDriverId = data.driverPhoneNumber;
    const patientRequest = await PatientRequest.findOne({ requestId: data.requestId });


    if (patientRequest) {
      console.log("in if condistion");
      // Find the next nearest driver excluding the denied driver
      const nearestDriver = await findNearestDriver(patientRequest.pickupLocation, [deniedDriverId]);
      console.log(nearestDriver);

      if (nearestDriver && driverSockets.has(nearestDriver.phoneNumber)) {
        const driverSocket = driverSockets.get(nearestDriver.phoneNumber);
        driverSocket.emit('newRequest', patientRequest);
        console.log('Request reassigned to driver:', nearestDriver.phoneNumber);
      } else {
        console.log('No available drivers to reassign the request');
      }
    }
  });
// cancel ride kal karege
  socket.on('cancelRide', async (data) => {
    try {
      console.log(`Patient ${data.patientPhoneNumber} cancelled request ${data.requestId}`);
  
      // Find the patient request
      const patientRequest = await PatientRequest.findOne({ requestId: data.requestId });
  
      if (patientRequest) {
        // Update the rideStatus to 'cancelled'
        patientRequest.rideStatus = 'cancelled';
        await patientRequest.save();
  
        // Retrieve driver's socket using stored phoneNumber
        const driverSocket = driverSockets.get(Number(patientRequest.driverPhoneNumber));
  
        if (driverSocket) {
          // Emit the cancellation event to the driver
          driverSocket.emit('rideCancelled', { requestId: data.requestId });
          console.log(`Notified driver ${patientRequest.driverPhoneNumber} about cancellation of request ${data.requestId}`);
        } else {
          console.log(`Driver socket not found for phone number: ${patientRequest.driverPhoneNumber}`);
        }
      } else {
        console.log(`Patient request not found for requestId: ${data.requestId}`);
      }
    } catch (error) {
      console.error('Error handling cancelRide event:', error);
    }
  });
  socket.on('completeRide', async (data) => {
    try {
      console.log(`Driver completed ride for request ${data.requestId}`);
  
      // Find the patient request
      const patientRequest = await PatientRequest.findOne({ requestId: data.requestId });
  
      if (patientRequest) {
        // Update the rideStatus to 'completed'
        patientRequest.rideStatus = 'completed';
        patientRequest.paymentStatus='completed'
        await patientRequest.save();
  
        // Emit the completed ride details to the patient
        const patientSocket = clientSockets.get(Number(patientRequest.patientPhoneNumber));
        if (patientSocket) {
          patientSocket.emit('rideCompleted', patientRequest);
          console.log(`Notified patient ${patientRequest.patientPhoneNumber} about completion of request ${data.requestId}`);
        } else {
          console.log(`Patient socket not found for phone number: ${patientRequest.patientPhoneNumber}`);
        }
      }
  
    } catch (error) {
      console.error('Error handling completeRide event:', error);
    }
  });
 socket.on('otpVerified', async (data) => {
    try {
      // console.log(`Driver notified drop-off for request ${data.requestId}`);
  
      // Find the patient request
      const patientRequest = await PatientRequest.findOne({ requestId: data.requestId });
  
      if (patientRequest) {
        // Emit the drop-off notification to the patient
        const patientSocket = clientSockets.get(Number(patientRequest.patientPhoneNumber));
        if (patientSocket) {
          patientSocket.emit('otpVerifyNotified', patientRequest);
          console.log(`Notified patient ${patientRequest.patientPhoneNumber} about drop-off for request ${data.requestId}`);
        } else {
          console.log(`Patient socket not found for phone number: ${patientRequest.patientPhoneNumber}`);
        }
      } else {
        console.log(`Patient request not found for requestId: ${data.requestId}`);
      }
    } catch (error) {
      console.error('Error handling dropOff event:', error);
    }
  });
  
  // he
 socket.on('dropOff', async (data) => {
    try {
      console.log(`Driver notified drop-off for request ${data.requestId}`);
  
      // Find the patient request
      const patientRequest = await PatientRequest.findOne({ requestId: data.requestId });
  
      if (patientRequest) {
        // Emit the drop-off notification to the patient
        const patientSocket = clientSockets.get(Number(patientRequest.patientPhoneNumber));
        if (patientSocket) {
          patientSocket.emit('dropOffNotified', { requestId: data.requestId });
          console.log(`Notified patient ${patientRequest.patientPhoneNumber} about drop-off for request ${data.requestId}`);
        } else {
          console.log(`Patient socket not found for phone number: ${patientRequest.patientPhoneNumber}`);
        }
      } else {
        console.log(`Patient request not found for requestId: ${data.requestId}`);
      }
    } catch (error) {
      console.error('Error handling dropOff event:', error);
    }
  });
  
// Handle payment completion
socket.on('paymentCompleted', async (data) => {
  console.log("in paymentCompleted event =================");
  console.log(data);
  console.log("this is the type of the data");
  console.log(typeof data);

  const { requestId, paymentId, paymentStatus, paymentMethod } = data;

  try {
    const request = await PatientRequest.findOne({ requestId });

    if (request) {
      request.paymentStatus = paymentStatus;
      request.paymentMethod = paymentMethod;
      request.paymentId = paymentId;
      await request.save();

      console.log("Payment information saved successfully");

      const driverPhoneNumber = Number(request.driverPhoneNumber);

      const driverSocket = driverSockets.get(driverPhoneNumber);
      console.log(driverSocket);
     
      if (driverSocket) {
        console.log("Patient socket found for phone number:", driverPhoneNumber);
        // Emit the updated payment details to the client
        driverSocket.emit('paymentStatusUpdated', request);
        console.log('paymentStatusUpdated event emitted to client');
      } else {
        console.log(`Client socket not found for phone number: ${driverPhoneNumber}`);
        console.log("Current clientSockets map:", Array.from(driverSockets.keys()));
      }
      console.log(`Payment for request ${requestId} completed`);
    } else {
      console.log(`Request not found for requestId: ${requestId}`);
    }
  } catch (error) {
    console.error('Error handling paymentCompleted event:', error);
  }
}
);

  socket.on("paymentMathod",async (data)=>{
  try {
    // console.log(`Driver completed ride for request ${data.requestId}`);

    // Find the patient request
    const patientRequest = await PatientRequest.findOne({ requestId: data.requestId });

    if (patientRequest) {
      patientRequest.paymentStatus=data.paymentMethod;
      await patientRequest.save();

      // Emit the completed ride details to the patient
      const driverSocket = driverSockets.get(Number(patientRequest.patientPhoneNumber));
      if (driverSocket) {
        driverSocket.emit('paymentMathodNotified', patientRequest);
     } else {
        console.log(`driver socket not found for phone number: ${patientRequest.driverPhoneNumber}`);
      }
    }

  } catch (error) {
    console.error('Error handling paymentMethod event:', error);
  }
});

  // Handle driver disconnection
  socket.on('disconnect', () => {
    for (const [phoneNumber, driverSocket] of driverSockets.entries()) {
      if (driverSocket === socket) {
        driverSockets.delete(phoneNumber);
        console.log('Driver disconnected:', phoneNumber);
        break;
      }
    }
    for (const [phoneNumber, clientSocket] of clientSockets.entries()) {
      if (clientSocket === socket) {
        clientSockets.delete(phoneNumber);
        console.log('Client disconnected:', phoneNumber);
        break;
      }
    }
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });

  // Handle phoneNumber event
  socket.on('phoneNumber', (phoneNumber) => {
    console.log('Received phoneNumber:', phoneNumber);

    // Store the socket connection with phoneNumber
    driverSockets.set(phoneNumber, socket);

    // Set up a change stream to listen for changes in the Driver collection
    const changeStream = Driver.watch();

    changeStream.on('change', async (change) => {
      console.log('Change occurred:', change);

      // Extract the updated document from the change event
      const updatedDocument = await Driver.findById(change.documentKey._id);
      console.log('Updated Document:', updatedDocument);

      // Emit the updated document to the specific client's socket
      if (updatedDocument) {
        socket.emit('driverLocation', { latitude: updatedDocument.latitude, longitude: updatedDocument.longitude });
      }
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
      // Remove socket from driverSockets map when disconnected
      driverSockets.forEach((value, key) => {
        if (value === socket) {
          driverSockets.delete(key);
        }
      });
      changeStream.close();
    });
  });
});




// Watch the request collection for new requests
const requestChangeStream = PatientRequest.watch();

// requestChangeStream.on('change', async (change) => {
//   if (change.operationType === 'insert') {
//     const newRequest = change.fullDocument;
//     console.log('New request detected:', newRequest);
//     console.log('Date:', newRequest.Date);
//     console.log('Time:', newRequest.Time);
//     // Find the nearest driver excluding none initially
//     const { nearestDriver, shortestDistance } = await findNearestDriver(newRequest.pickupLocation);

//     if (nearestDriver && shortestDistance !== Infinity) {
//       console.log("this is driverSocket ");
//       console.log(driverSockets);
//       console.log("Driver data========================");
//       console.log(nearestDriver);
//       console.log("=================================================");
//       console.log(driverSockets.has(Number(nearestDriver.phoneNumber)))
//       // 8828456655 
   

    
//       // Emit the request to the nearest driver if their socket connection exists
//       if (driverSockets.has(Number(nearestDriver.phoneNumber))) {
//         const driverSocket = driverSockets.get(Number(nearestDriver.phoneNumber));
//         driverSocket.emit('newRequest', newRequest);
//         console.log(`Request dispatched to driver: ${nearestDriver.phoneNumber}`);
//       } else {
//         console.log(`Driver socket not found for phone number: ${nearestDriver.phoneNumber}`);
//       }
//     } else {
//       console.log('No available drivers to handle the new request');
//     }
//   } else {
//     console.log('Something happened with PatientRequest document');
//   }
// });


requestChangeStream.on('change', async (change) => {
  if (change.operationType === 'insert') {
    const newRequest = change.fullDocument;
    console.log('New request detected:', newRequest);

    // Check if Date and Time fields are present in newRequest
    console.log('Date:', newRequest.Date);
    console.log('Time:', newRequest.Time);

    // Find the nearest driver excluding none initially
    const { nearestDriver, shortestDistance } = await findNearestDriver(newRequest.pickupLocation);

    if (nearestDriver && shortestDistance !== Infinity) {
      // Emit the request to the nearest driver if their socket connection exists
      if (driverSockets.has(Number(nearestDriver.phoneNumber))) {
        const driverSocket = driverSockets.get(Number(nearestDriver.phoneNumber));

        // Emit the event with newRequest including Date and Time
        driverSocket.emit('newRequest', newRequest);
        console.log(`Request dispatched to driver: ${nearestDriver.phoneNumber}`);
      } else {
        console.log(`Driver socket not found for phone number: ${nearestDriver.phoneNumber}`);
      }
    } else {
      console.log('No available drivers to handle the new request');
      await PatientRequest.findOneAndDelete({ requestId: newRequest.requestId });
      const clientSocket = clientSockets.get(Number(newRequest.patientPhoneNumber));
      if (clientSocket) {
        clientSocket.emit('noDriversAvailable', { requestId: newRequest.requestId });
      }
    }
  } else {
    console.log('Something happened with PatientRequest document');
  }
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Existing code...

  // Handle registering a salesman
  socket.on('registerSalesman', (userId) => {
    console.log(userId);
    salesmanSockets.set(userId, socket);
    console.log('Salesman registered:', userId);
  });

  // Handle location updates from salesmen
  socket.on('updateLocation', async (data) => {
    const { userId, location } = data;
    console.log(`Salesman ${userId} updated location:`, location);

    // Update the salesman's location in the database
    const salesman = await Salesman.findOne({ userId });
    if (salesman) {
      salesman.location = location;
      await salesman.save();
      console.log(`Salesman ${userId} location updated in the database.`);
    } else {
      console.log(`Salesman not found for userId: ${userId}`);
    }

    // Emit the location update to the admin
    io.emit('salesmanLocationUpdate', { userId, location });
  });

  // Handle salesman disconnection
  socket.on('disconnect', () => {
    for (const [userId, salesmanSocket] of salesmanSockets.entries()) {
      if (salesmanSocket.id === socket.id) {
        salesmanSockets.delete(userId);
        console.log('Salesman disconnected:', userId);
        break;
      }
    }

    // Clean up the driver and client maps
    driverSockets.forEach((s, phoneNumber) => {
      if (s.id === socket.id) {
        driverSockets.delete(phoneNumber);
      }
    });

    clientSockets.forEach((s, phoneNumber) => {
      if (s.id === socket.id) {
        clientSockets.delete(phoneNumber);
      }
    });
  });

  // Additional existing code...
});




const port = process.env.PORT || 3001;
server.listen(port, () => {
  console.log(`Server is listening on http://localhost:${port}`);
});
