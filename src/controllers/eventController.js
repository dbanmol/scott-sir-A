const Event = require("../models/Event");
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { checkTopPlannerBadge } = require('../utils/badgeUtils');
const { checkSpeedyVoterBadge } = require('../utils/badgeUtils');
const Group = require("../models/Group");
const createNotification = require('../utils/createNotification');
const { validationResult } = require("express-validator");

// Validation Done
exports.createEvent = async (req, res) => {
  try {
    const { name, location, description, votingTime, dates, invitationCustomization } = req.body;
    const userId = req.user.id;

    // Validate required fields
    if (!name || !location || !description || !votingTime || !dates) {
      return res.status(400).json({ status: false, message: "All fields are required" });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      console.error("User not found for ID:", userId);
      return res.status(404).json({ status: false, message: "User not found" });
    }

    // Check subscription status
    const now = new Date();
    const subscription = user.subscription;
    const hasPremium = subscription &&
      subscription.status === 'active' &&
      new Date(subscription.expiryDate) > now;

    // For non-premium, allow only 1 event
    if (!hasPremium) {
      const existingEventsCount = await Event.countDocuments({ createdBy: userId });

      if (existingEventsCount >= 1) {
        console.warn("Non-premium user tried to create more than 1 event");
        return res.status(403).json({
          status: false,
          message: "Upgrade to premium to create unlimited events"
        });
      }
    }

    // Handle theme selection
    let selectedTheme = "Theme1"; // Default theme
    if (hasPremium && invitationCustomization?.theme) {
      selectedTheme = invitationCustomization.theme;
    }

    // Create event
    const newEvent = new Event({
      name,
      location,
      description,
      votingTime,
      dates,
      type: "Planned",
      createdBy: userId,
      invitationCustomization: { theme: selectedTheme },
    });

    await newEvent.save();

    // Optional badge check logic
    await checkTopPlannerBadge(userId);

    // Format response like "planned list"
    const responseData = {
      id: newEvent._id,
      name: newEvent.name,
      location: newEvent.location,
      description: newEvent.description,
      invitationCustomization: newEvent.invitationCustomization,
      type: newEvent.type,
      creatorProfilePicture: {
        name: user.firstName || "Updated Firstname",  // Default to "Updated Firstname" if firstName is not available
        profilePicture: user.profilePicture
          ? `${process.env.LIVE_URL}/${user.profilePicture.replace(/\\/g, "/")}`
          : "",
      },
      voteCount: newEvent.votes ? newEvent.votes.length : 0,
      votersProfilePictures: [],
      finalizedDate: {
        date: "",
        timeSlot: "",
      },
    };

    return res.status(200).json({
      status: true,
      message: "Event created successfully",
      data: responseData,
    });

  } catch (error) {
    console.error("Create Event Error:", error);
    return res.status(500).json({ status: false, message: "Server error" });
  }
};



exports.getAllEvents = async (req, res) => {
  try {
    const userId = req.user.id;

    // Find events created by the user, of type "Planned"
    const events = await Event.find({ type: "Planned", createdBy: userId })
      .sort({ createdAt: -1 })
      .populate({ path: "createdBy", select: "first_name profilePicture" })
      .populate({ path: "votes.user", select: "profilePicture _id" });

    // If no events found, return an empty list
    if (events.length === 0) {
      return res.status(404).json({ status: false, message: "No events found" });
    }

    const modifiedEvents = events.map(event => {
      // Format dates with votes count
      const votesByDateMap = {};
      event.votes.forEach(vote => {
        if (!vote.date) return;
        const voteDateStr = new Date(vote.date).toISOString().split('T')[0];
        if (!votesByDateMap[voteDateStr]) {
          votesByDateMap[voteDateStr] = {
            count: 0,
            votersProfilePictures: []
          };
        }
        votesByDateMap[voteDateStr].count++;
        if (vote.user && vote.user.profilePicture) {
          votesByDateMap[voteDateStr].votersProfilePictures.push({
            userId: vote.user._id,
            profilePicture: `${process.env.LIVE_URL}/${vote.user.profilePicture}`
          });
        }
      });

      const datesWithVotes = event.dates.map(d => {
        const eventDateStr = new Date(d.date).toISOString().split('T')[0];
        return {
          date: d.date,
          timeSlot: d.timeSlot || "", // Default empty string if no timeSlot
          _id: d._id,  // Include _id for the timeSlot
          voteCount: votesByDateMap[eventDateStr]?.count || 0,
          votersProfilePictures: votesByDateMap[eventDateStr]?.votersProfilePictures || [],
        };
      });

      // Prepend the live URL to the creator's profile picture path
    const creatorProfilePictureUrl = {
  name: event.createdBy?.first_name || "",
  profilePicture: event.createdBy?.profilePicture
    ? `${process.env.LIVE_URL}/${event.createdBy.profilePicture.replace(/\\/g, "/")}`
    : ""
};

      // Handling finalizedDate
      const finalizedDate = event.finalizedDate
        ? {
            date: event.finalizedDate.date || "", // If no date, show empty string
            timeSlot: event.finalizedDate.timeSlot || "", // If no timeSlot, show empty string
          }
        : {
            date: "", // Default to empty string if no finalizedDate
            timeSlot: "", // Default to empty string if no finalizedDate
          };

      // Return the event details in the desired format
      return {
        id: event._id,  // Event ID
        name: event.name || "",
        location: event.location || "",
        description: event.description || "",

        invitationCustomization: event.invitationCustomization || '',
        type: event.type,
        creatorProfilePicture: creatorProfilePictureUrl,  // Add live URL before profilePicture path
        voteCount: event.votes.length || 0,
        votersProfilePictures: event.votes.length > 0 ? event.votes.map(vote => ({
          userId: vote.user?._id,
          profilePicture: vote.user?.profilePicture ? `${process.env.LIVE_URL}/${vote.user.profilePicture}` : ""
        })) : [],
        finalizedDate: finalizedDate, // Use the processed finalizedDate
      };
    });

    res.status(200).json({
      status: true,
      message: "Events Fetched successfully",
      data: modifiedEvents
    });
  } catch (error) {
    console.error("Get Events Error:", error);
    res.status(500).json({ status: false, message: "Failed to fetch events" });
  }
};




exports.getEventById = async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId)
      .populate({ path: 'invitedUsers', select: 'profilePicture _id' })
      .populate({ path: 'votes.user', select: 'profilePicture _id' })
      .populate({ path: 'createdBy', select: 'first_name' });

    if (!event) {
      return res.status(404).json({ status: false, message: "Event not found" });
    }

    if (!event.createdBy || event.createdBy._id.toString() !== req.user.id) {
      return res.status(403).json({ status: false, message: "Access denied. Only event creator can view this event." });
    }

    const formatWeekdayDate = (dateStr) => {
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const d = new Date(dateStr);
      const weekday = days[d.getUTCDay()];

      const year = d.getUTCFullYear();
      const month = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');

      return `${weekday} ${year}-${month}-${day}`;
    };

    let remainingTimeMs = 0;
    let remainingTimeText = "Voting ended";

    if (event.votingTime && event.createdAt) {
      const match = event.votingTime.match(/^(\d+)\s*hrs?$/i);
      if (match) {
        const hoursAllowed = parseInt(match[1], 10);
        const votingEnd = new Date(event.createdAt.getTime() + hoursAllowed * 60 * 60 * 1000);
        const now = new Date();
        remainingTimeMs = votingEnd - now > 0 ? votingEnd - now : 0;

        if (remainingTimeMs > 0) {
          const hoursRemaining = Math.floor(remainingTimeMs / (1000 * 60 * 60));
          const minutesRemaining = Math.floor((remainingTimeMs % (1000 * 60 * 60)) / (1000 * 60));

          if (hoursRemaining > 0) {
            remainingTimeText = `${hoursRemaining} hour${hoursRemaining > 1 ? "s" : ""} remaining`;
            if (minutesRemaining > 0) {
              remainingTimeText += ` ${minutesRemaining} minute${minutesRemaining > 1 ? "s" : ""}`;
            }
          } else if (minutesRemaining > 0) {
            remainingTimeText = `${minutesRemaining} minute${minutesRemaining > 1 ? "s" : ""} remaining`;
          } else {
            remainingTimeText = "Less than a minute remaining";
          }
        }
      }
    }

    const votesByDateMap = {};
    event.votes.forEach(vote => {
      if (!vote.date) return;
      const voteDateStr = new Date(vote.date).toISOString().split('T')[0];
      if (!votesByDateMap[voteDateStr]) {
        votesByDateMap[voteDateStr] = {
          count: 0,
          votersProfilePictures: []
        };
      }
      votesByDateMap[voteDateStr].count++;
      if (vote.user && vote.user.profilePicture) {
        votesByDateMap[voteDateStr].votersProfilePictures.push({
          userId: vote.user._id,
          profilePicture: `${process.env.LIVE_URL}/${vote.user.profilePicture}`
        });
      }
    });

    const datesWithVotes = event.dates.map(d => {
      const eventDateStr = new Date(d.date).toISOString().split('T')[0];
      return {
        date: formatWeekdayDate(d.date),
        timeSlot: d.timeSlot || "", // Default empty string if no timeSlot
        voteCount: votesByDateMap[eventDateStr]?.count || 0,
        votersProfilePictures: votesByDateMap[eventDateStr]?.votersProfilePictures || [],
      };
    });

    // Add Live URL and userId to invited users' profile pictures
    const invitedUsersProfilePics = event.invitedUsers.map(u => ({
      userId: u._id,
      profilePicture: u.profilePicture ? `${process.env.LIVE_URL}/${u.profilePicture}` : ''
    }));

    // Fetch invitationCustomization, default to "Lavender" if not present
    const invitationCustomization = event.invitationCustomization || { premiumTheme: "Theme1" };

    const eventDetails = {
      id: event._id, // Add eventId (same as _id)
      name: event.name || "",
      location: event.location || "",
      description: event.description || "",
      invitationCustomization: invitationCustomization, 
      invitedUsersCount: event.invitedUsers.length || 0,
      invitedUsersProfilePics: invitedUsersProfilePics || [],
      remainingVotingTime: remainingTimeText || "Voting ended",
      dates: datesWithVotes || [], // Default to an empty array if no dates
    };

    res.status(200).json({ status: true, message: 'Event Fetched Successfully', data: eventDetails });
  } catch (error) {
    console.error("Get Event Error:", error);
    res.status(500).json({ status: false, message: "Server error" });
  }
};




exports.AcceptInvite = async (req, res) => {
  try {
    const { eventId } = req.body;
    const userId = req.user.id;

    if (!eventId) {
      return res.status(400).json({ status: false, message: "Event ID is required" });
    }

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ status: false, message: "Event not found" });
    }

    // Add user to invitedUsers if not already invited
    if (!event.invitedUsers.includes(userId)) {
      event.invitedUsers.push(userId);
      await event.save();
    }

    const shareLink = `https://oyster-app-g2hmu.ondigitalocean.app/api/events/invite?eventId=${eventId}`;

    res.status(200).json({
      status: true,
      message: "Invitation Accepted Successfully",
        });
  } catch (error) {
    console.error("Get Share Link Error:", error);
    res.status(500).json({
      status: false,
      message: "Failed to generate share link",
    });
  }
};


exports.handleInviteLink = async (req, res) => {
  const { eventId } = req.query;

  if (!eventId) {
    return res.status(400).json({ status: false, message: "Missing event ID" });
  }

  try {
    const event = await Event.findById(eventId)
      .populate('createdBy', 'first_name last_name profilePicture')
      .lean();

    if (!event) {
      return res.status(404).json({ status: false, message: "Event not found" });
    }

    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        status: false,
        message: "Please login/signup to view the event",
        redirectTo: `/signup?redirect=/invite?eventId=${eventId}`,
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
    } catch (err) {
      return res.status(401).json({ status: false, message: "Invalid token", error: err.message });
    }

    const userId = req.user.id;

    if (event.createdBy._id.toString() === userId) {
      return res.status(403).json({ status: false, message: "Event creator cannot access this invite link." });
    }

    if (!event.invitedUsers.some(u => u.toString() === userId)) {
      event.invitedUsers.push(userId);
      await Event.findByIdAndUpdate(eventId, { invitedUsers: event.invitedUsers });
    }

    const responseEvent = {
      name: event.name,
      location: event.location || '',
      description: event.description || '',
      creator: {
        name: `${event.createdBy.first_name} ${event.createdBy.last_name}`,
        profilePicture: event.createdBy.profilePicture || '',
      },
      finalizedDate: event.finalizedDate && event.finalizedDate.date
        ? event.finalizedDate
        : [],
    };

    res.status(200).json({ status: true, message: 'Event Joined Successfully', data: responseEvent });

  } catch (err) {
    console.error("Invite Link Error:", err);
    res.status(500).json({ status: false, message: "Server error" });
  }
};

exports.getInvitedEventDetailsForVoting = async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.user.id;

    // Fetch the event by its ID and populate the necessary fields
    const event = await Event.findById(eventId)
      .populate({ path: 'createdBy', select: 'first_name profilePicture' })
      .populate({ path: 'invitedUsers', select: 'profilePicture' });

    if (!event) {
      return res.status(404).json({ status: false, message: "Event not found" });
    }

    // Check if the user is invited to the event
    if (!event.invitedUsers.some(user => user._id.toString() === userId)) {
      return res.status(403).json({ status: false, message: "User is not invited to this event." });
    }

    // Prevent the event creator from accessing voting details
    if (event.createdBy._id.toString() === userId) {
      return res.status(403).json({ status: false, message: "Event creator cannot access this voting details." });
    }

    // Helper function to format date
    const getFormattedDate = (dateStr) => {
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const dateObj = new Date(dateStr);
      const weekday = days[dateObj.getDay()];

      const year = dateObj.getFullYear();
      const month = String(dateObj.getMonth() + 1).padStart(2, '0');
      const day = String(dateObj.getDate()).padStart(2, '0');

      return `${weekday} ${year}-${month}-${day}`;
    };

    // Format event dates
    const datesWithFormattedDate = event.dates.map(dateObj => ({
      date: getFormattedDate(dateObj.date),
      timeSlot: dateObj.timeSlot,
    }));

    // Collect profile pictures of the invited users
    const invitedUsersProfilePics = event.invitedUsers.map(user => user.profilePicture
      ? `${process.env.LIVE_URL}/${user.profilePicture.replace(/\\/g, '/')}`
      : ''
    );

    let finalizedDate = "";
    if (event.finalizedDate && event.finalizedDate.date) {
      finalizedDate = getFormattedDate(event.finalizedDate.date);
    }

    // Construct event details response
    const eventDetails = {
      eventId: event._id,
      name: event.name,
      location: event.location,
      description: event.description,
      creator: {
        name: event.createdBy?.first_name || '',
        profilePicture: event.createdBy?.profilePicture
          ? `${process.env.LIVE_URL}/${event.createdBy.profilePicture.replace(/\\/g, '/')}`
          : '',
      },
      dates: datesWithFormattedDate,
      invitedUsersCount: event.invitedUsers.length,
      invitedUsersProfilePics,
      finalizedDate,
      timeSlot: event.finalizedDate?.timeSlot || '',
    };

    res.status(200).json({
      status: true,
      message: 'Event Fetched Successfully',
      data: eventDetails
    });
  } catch (error) {
    console.error("Get Event Details For Voting Error:", error);
    res.status(500).json({ status: false, message: "Server error" });
  }
};



// Validation Done
exports.voteOnEvent = async (req, res) => {
  const { eventId } = req.params;
  const { selectedDate } = req.body;
  const userId = req.user.id;

  // const errors = validationResult(req);
  // if (!errors.isEmpty()) {
  //   return res.status(400).json({
  //     status: false,
  //     message: errors.array()[0].msg,
  //   });
  // }

  try {
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ status: false, message: "Event not found" });
    }

    if (event.createdBy.toString() === userId) {
      return res.status(403).json({ status: false, message: "Event creator cannot vote for their own event." });
    }

    if (!event.invitedUsers.some(user => user.toString() === userId)) {
      return res.status(403).json({ status: false, message: "You are not invited to vote on this event." });
    }

    if (!selectedDate) {
      return res.status(400).json({ status: false, message: "Please select a date to vote." });
    }

    const validDateObj = event.dates.find(d => new Date(d.date).toISOString().split('T')[0] === new Date(selectedDate).toISOString().split('T')[0]);
    if (!validDateObj) {
      return res.status(400).json({ status: false, message: "Selected date is not valid for this event." });
    }

    const alreadyVoted = event.votes.some(vote => vote.user.toString() === userId);
    if (alreadyVoted) {
      return res.status(400).json({ status: false, message: "You already voted" });
    }

    event.votes.push({ user: userId, date: new Date(selectedDate).toISOString().split('T')[0] });
    await event.save();

    let group = await Group.findOne({ eventId });
    if (!group) {
      group = await Group.create({
        eventId,
        members: [userId],
      });
    } else {
      if (!group.members.some(m => m.toString() === userId)) {
        group.members.push(userId);
        await group.save();
      }
    }

    await checkSpeedyVoterBadge(userId);

    res.status(200).json({ status: true, message: "Vote submitted", voteCount: event.votes.length, groupId: group._id });
  } catch (err) {
    console.error("Vote Error:", err);
    res.status(500).json({ status: false, message: "Server error" });
  }
};

exports.getInvitedEvents = async (req, res) => {
  try {
    const userId = req.user.id;

    // Find events where user is invited but not the creator
    const events = await Event.find({
      invitedUsers: userId,
      createdBy: { $ne: userId },
    })
      .populate({
        path: "createdBy",
        select: "first_name profilePicture",
      })
      .populate({
        path: "votes.user",
        select: "profilePicture _id",
      });

    if (events.length === 0) {
      console.log("No invited events found for user.");
      return res.status(404).json({
        success: false,
        message: "No invited events found for the user.",
      });
    }

    const simplifiedEvents = events.map(event => {
      // --- Votes by date processing ---
      const votesByDateMap = {};
      event.votes.forEach(vote => {
        if (!vote.date) return;
        const voteDateStr = new Date(vote.date).toISOString().split('T')[0];
        if (!votesByDateMap[voteDateStr]) {
          votesByDateMap[voteDateStr] = {
            count: 0,
            votersProfilePictures: []
          };
        }
        votesByDateMap[voteDateStr].count++;
        if (vote.user && vote.user.profilePicture) {
          votesByDateMap[voteDateStr].votersProfilePictures.push({
            userId: vote.user._id,
            profilePicture: `${process.env.LIVE_URL}/${vote.user.profilePicture.replace(/\\/g, "/")}`
          });
        }
      });

      // --- Dates with vote info ---
      const datesWithVotes = event.dates.map(d => {
        const eventDateStr = new Date(d.date).toISOString().split('T')[0];
        return {
          date: d.date,
          timeSlot: d.timeSlot || "",
          _id: d._id,
          voteCount: votesByDateMap[eventDateStr]?.count || 0,
          votersProfilePictures: votesByDateMap[eventDateStr]?.votersProfilePictures || [],
        };
      });

      // --- Creator details ---
      const creator = {
        name: event.createdBy?.first_name || "",
        profilePicture: event.createdBy?.profilePicture
          ? event.createdBy.profilePicture.replace(/\\/g, "/")
          : ""
      };

      const creatorProfilePictureUrl = creator.profilePicture
        ? `${process.env.LIVE_URL}/${creator.profilePicture}`
        : "";

      // --- Finalized date ---
      const finalizedDate = event.finalizedDate
        ? {
            date: event.finalizedDate.date || "",
            timeSlot: event.finalizedDate.timeSlot || ""
          }
        : {
            date: "",
            timeSlot: ""
          };

      return {
        id: event._id,
        name: event.name || "",
        location: event.location || "",
        description: event.description || "",
        invitationCustomization: event.invitationCustomization || '',
        type: "Invited",
       creatorProfilePicture: {
  name: creator.name,
  profilePicture: creator.profilePicture
    ? `${process.env.LIVE_URL}/${creator.profilePicture}`
    : ""
},
        voteCount: event.votes.length || 0,
        votersProfilePictures: event.votes.length > 0
          ? event.votes.map(vote => ({
              userId: vote.user?._id,
              profilePicture: vote.user?.profilePicture
                ? `${process.env.LIVE_URL}/${vote.user.profilePicture.replace(/\\/g, "/")}`
                : ""
            }))
          : [],
        finalizedDate
      };
    });

    res.status(200).json({
      status: true,
      message: "Event Fetched Successfully",
      data: simplifiedEvents
    });

  } catch (error) {
    console.error("Get Invited Events Error:", error);
    res.status(500).json({
      status: false,
      message: "Server error"
    });
  }
};





exports.getVotersByDate = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { selectedDate } = req.query;

    if (!selectedDate) {
      return res.status(400).json({
        status: false,
        message: "Please provide selectedDate query parameter."
      });
    }

    const event = await Event.findById(eventId).populate('votes.user', 'first_name profilePicture');

    if (!event) {
      return res.status(404).json({
        status: false,
        message: "Event not found."
      });
    }

    if (event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({
        status: false,
        message: "Only event creator can view voters for a date."
      });
    }

    const selectedDateISO = new Date(selectedDate).toISOString().split('T')[0];

    const votersForDate = event.votes.filter(vote => {
      const voteDateISO = new Date(vote.date).toISOString().split('T')[0];
      return voteDateISO === selectedDateISO;
    }).map(vote => ({
      userId: vote.user._id,
      name: vote.user.first_name,
      profilePicture: vote.user.profilePicture
        ? `${process.env.LIVE_URL}/${vote.user.profilePicture.replace(/\\/g, '/')}`
        : ""
    }));

    res.status(200).json({
      status: true,
      message: "Voters for the selected date retrieved successfully.",
      data: {
        eventId,
        date: selectedDateISO,
        voters: votersForDate,
        totalVoters: votersForDate.length
      }
    });

  } catch (error) {
    console.error("Get Voters By Date Error:", error);
    res.status(500).json({
      status: false,
      message: "Server error"
    });
  }
};

// Validation Done 
exports.finalizeEventDate = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { selectedDate } = req.body;

    if (!selectedDate) {
      return res.status(400).json({ status: false, message: "Please provide the selected date to finalize." });
    }

    const event = await Event.findById(eventId).populate('votes.user', '_id first_name');

    if (!event) {
      return res.status(404).json({ status: false, message: "Event not found." });
    }

    if (event.finalizedDate && event.finalizedDate.date) {
      return res.status(400).json({
        status: false,
        message: "Event date has already been finalized and cannot be changed."
      });
    }
    
    if (event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ status: false, message: "Access denied. Only event creator can finalize the date." });
    }

    const selectedDateISO = new Date(selectedDate).toISOString().split('T')[0];
    const dateOption = event.dates.find(d => new Date(d.date).toISOString().split('T')[0] === selectedDateISO);

    if (!dateOption) {
      return res.status(400).json({ status: false, message: "Selected date option not found in event." });
    }

    event.finalizedDate = {
      date: new Date(selectedDateISO),
      timeSlot: dateOption.timeSlot,
    };

    await event.save();

    const title = "Event is Confirmed!";
    const message = `The event ${event.name} has been finalized for ${selectedDateISO}. See you there!`;

    const votersForDate = event.votes.filter(vote => {
      const voteDateISO = new Date(vote.date).toISOString().split('T')[0];
      return voteDateISO === selectedDateISO;
    });

    await Promise.all(votersForDate.map(vote =>
      createNotification(vote.user._id, title, message)
    ));

    res.status(200).json({ status: true, message: "Date finalized successfully.", data: event.finalizedDate });
  } catch (error) {
    console.error("Finalize Event Date Error:", error);
    res.status(500).json({ status: false, message: "Server error" });
  }
};

